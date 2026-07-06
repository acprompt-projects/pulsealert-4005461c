import time
import json
import smtplib
import logging
import threading
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
from collections import deque
from enum import Enum

logger = logging.getLogger("pulsealert.dispatcher")


class ChannelType(Enum):
    SLACK = "slack"
    EMAIL = "email"
    WEBHOOK = "webhook"


@dataclass
class Notification:
    id: str
    channel: ChannelType
    recipient: str
    subject: str
    body: str
    severity: str = "info"
    metadata: Dict[str, Any] = field(default_factory=dict)
    attempts: int = 0
    max_attempts: int = 3
    created_at: float = field(default_factory=time.time)
    last_attempt_at: Optional[float] = None
    error: Optional[str] = None


@dataclass
class DeadLetterEntry:
    notification: Notification
    reason: str
    failed_at: float = field(default_factory=time.time)


@dataclass
class ChannelConfig:
    type: ChannelType
    max_retries: int = 3
    retry_base_delay: float = 2.0
    rate_limit: int = 60
    rate_window: float = 60.0
    options: Dict[str, Any] = field(default_factory=dict)


class Channel(ABC):
    def __init__(self, config: ChannelConfig):
        self.config = config
        self._timestamps: deque = deque()

    def _check_rate_limit(self) -> bool:
        now = time.time()
        while self._timestamps and now - self._timestamps[0] > self.config.rate_window:
            self._timestamps.popleft()
        if len(self._timestamps) >= self.config.rate_limit:
            return False
        self._timestamps.append(now)
        return True

    def send(self, notification: Notification) -> bool:
        if not self._check_rate_limit():
            logger.warning(f"Rate limit hit for {self.config.type.value}")
            return False
        try:
            result = self._deliver(notification)
            if result:
                logger.info(f"Delivered notification {notification.id} via {self.config.type.value}")
            return result
        except Exception as e:
            logger.error(f"Delivery failed for {notification.id}: {e}")
            notification.error = str(e)
            return False

    @abstractmethod
    def _deliver(self, notification: Notification) -> bool:
        ...


class SlackChannel(Channel):
    def _deliver(self, notification: Notification) -> bool:
        webhook_url = self.config.options.get("webhook_url", "")
        if not webhook_url:
            raise ValueError("Slack webhook_url not configured")
        severity_colors = {
            "critical": "#FF0000", "warning": "#FFA500",
            "info": "#36A64F", "ok": "#36A64F",
        }
        payload = {
            "channel": notification.recipient,
            "attachments": [{
                "color": severity_colors.get(notification.severity, "#808080"),
                "title": notification.subject,
                "text": notification.body,
                "fields": [
                    {"title": k, "value": str(v), "short": True}
                    for k, v in notification.metadata.items() if v is not None
                ],
                "ts": int(notification.created_at),
            }],
        }
        data = json.dumps(payload).encode("utf-8")
        req = Request(webhook_url, data=data, headers={"Content-Type": "application/json"})
        try:
            with urlopen(req, timeout=10) as resp:
                return resp.status == 200
        except (HTTPError, URLError) as e:
            raise RuntimeError(f"Slack delivery error: {e}")


class EmailChannel(Channel):
    def _deliver(self, notification: Notification) -> bool:
        smtp_host = self.config.options.get("smtp_host", "localhost")
        smtp_port = self.config.options.get("smtp_port", 587)
        use_tls = self.config.options.get("use_tls", True)
        username = self.config.options.get("username")
        password = self.config.options.get("password")
        from_addr = self.config.options.get("from_address", "pulsealert@localhost")

        msg = MIMEMultipart("alternative")
        msg["From"] = from_addr
        msg["To"] = notification.recipient
        msg["Subject"] = f"[{notification.severity.upper()}] {notification.subject}"
        msg.attach(MIMEText(notification.body, "plain"))
        if "html_body" in notification.metadata:
            msg.attach(MIMEText(notification.metadata["html_body"], "html"))

        with smtplib.SMTP(smtp_host, smtp_port, timeout=15) as server:
            if use_tls:
                server.starttls()
            if username and password:
                server.login(username, password)
            server.sendmail(from_addr, [notification.recipient], msg.as_string())
        return True


class WebhookChannel(Channel):
    def _deliver(self, notification: Notification) -> bool:
        url = notification.recipient
        secret = self.config.options.get("secret", "")
        payload = {
            "id": notification.id,
            "severity": notification.severity,
            "subject": notification.subject,
            "body": notification.body,
            "metadata": notification.metadata,
            "timestamp": notification.created_at,
        }
        headers = {"Content-Type": "application/json"}
        if secret:
            import hmac, hashlib
            body = json.dumps(payload).encode("utf-8")
            sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
            headers["X-PulseAlert-Signature"] = f"sha256={sig}"
        data = json.dumps(payload).encode("utf-8")
        req = Request(url, data=data, headers=headers, method="POST")
        try:
            with urlopen(req, timeout=10) as resp:
                return 200 <= resp.status < 300
        except (HTTPError, URLError) as e:
            raise RuntimeError(f"Webhook delivery error: {e}")


CHANNEL_FACTORY = {
    ChannelType.SLACK: SlackChannel,
    ChannelType.EMAIL: EmailChannel,
    ChannelType.WEBHOOK: WebhookChannel,
}


class NotificationDispatcher:
    def __init__(self, configs: Optional[Dict[ChannelType, ChannelConfig]] = None):
        self.channels: Dict[ChannelType, Channel] = {}
        self.dead_letter_queue: List[DeadLetterEntry] = []
        self._retry_queue: deque = deque()
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._retry_thread: Optional[threading.Thread] = None

        if configs:
            for ctype, cfg in configs.items():
                self.add_channel(cfg)

    def add_channel(self, config: ChannelConfig) -> None:
        cls = CHANNEL_FACTORY.get(config.type)
        if not cls:
            raise ValueError(f"Unknown channel type: {config.type}")
        self.channels[config.type] = cls(config)

    def dispatch(self, notification: Notification) -> bool:
        channel = self.channels.get(notification.channel)
        if not channel:
            logger.error(f"No channel configured for {notification.channel.value}")
            self._move_to_dlq(notification, "channel_not_configured")
            return False
        notification.max_attempts = channel.config.max_retries + 1
        success = channel.send(notification)
        notification.attempts += 1
        notification.last_attempt_at = time.time()
        if success:
            return True
        if notification.attempts >= notification.max_attempts:
            self._move_to_dlq(notification, "max_retries_exceeded")
            return False
        self._schedule_retry(notification, channel)
        return False

    def _schedule_retry(self, notification: Notification, channel: Channel) -> None:
        delay = channel.config.retry_base_delay * (2 ** (notification.attempts - 1))
        retry_at = time.time() + delay
        logger.info(f"Scheduling retry for {notification.id} in {delay:.1f}s (attempt {notification.attempts})")
        with self._lock:
            self._retry_queue.append((retry_at, notification))

    def _move_to_dlq(self, notification: Notification, reason: str) -> None:
        entry = DeadLetterEntry(notification=notification, reason=reason)
        self.dead_letter_queue.append(entry)
        logger.warning(f"Notification {notification.id} moved to DLQ: {reason}")

    def process_retries(self) -> int:
        processed = 0
        now = time.time()
        with self._lock:
            still_pending = deque()
            while self._retry_queue:
                retry_at, notification = self._retry_queue.popleft()
                if retry_at <= now:
                    self.dispatch(notification)
                    processed += 1
                else:
                    still_pending.append((retry_at, notification))
            self._retry_queue = still_pending
        return processed

    def start_retry_worker(self, interval: float = 1.0) -> None:
        def _worker():
            while not self._stop_event.is_set():
                self.process_retries()
                self._stop_event.wait(interval)
        self._retry_thread = threading.Thread(target=_worker, daemon=True, name="retry-worker")
        self._retry_thread.start()
        logger.info("Retry worker started")

    def stop(self) -> None:
        self._stop_event.set()
        if self._retry_thread:
            self._retry_thread.join(timeout=5)
        logger.info("Dispatcher stopped")

    @property
    def pending_retries(self) -> int:
        with self._lock:
            return len(self._retry_queue)

    def get_dead_letters(self, limit: int = 100) -> List[DeadLetterEntry]:
        return self.dead_letter_queue[-limit:]

    def replay_dead_letter(self, index: int) -> bool:
        if index < 0 or index >= len(self.dead_letter_queue):
            return False
        entry = self.dead_letter_queue.pop(index)
        notification = entry.notification
        notification.attempts = 0
        notification.error = None
        logger.info(f"Replaying DLQ notification {notification.id}")
        return self.dispatch(notification)


def create_dispatcher_from_env() -> NotificationDispatcher:
    import os
    configs: Dict[ChannelType, ChannelConfig] = {}
    if os.getenv("SLACK_WEBHOOK_URL"):
        configs[ChannelType.SLACK] = ChannelConfig(
            type=ChannelType.SLACK,
            options={"webhook_url": os.environ["SLACK_WEBHOOK_URL"]},
        )
    if os.getenv("SMTP_HOST"):
        configs[ChannelType.EMAIL] = ChannelConfig(
            type=ChannelType.EMAIL,
            options={
                "smtp_host": os.environ["SMTP_HOST"],
                "smtp_port": int(os.environ.get("SMTP_PORT", "587")),
                "use_tls": os.environ.get("SMTP_TLS", "true").lower() == "true",
                "username": os.environ.get("SMTP_USER"),
                "password": os.environ.get("SMTP_PASS"),
                "from_address": os.environ.get("SMTP_FROM", "pulsealert@localhost"),
            },
        )
    if os.getenv("WEBHOOK_SECRET"):
        configs[ChannelType.WEBHOOK] = ChannelConfig(
            type=ChannelType.WEBHOOK,
            options={"secret": os.environ["WEBHOOK_SECRET"]},
        )
    return NotificationDispatcher(configs)