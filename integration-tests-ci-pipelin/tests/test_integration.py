import json
import time
import threading
import unittest
from http.server import HTTPServer, BaseHTTPRequestHandler
from unittest.mock import patch, MagicMock

# --- Minimal in-process doubles for the services PulseAlert depends on ---

class SlackStubHandler(BaseHTTPRequestHandler):
    """Records payloads POSTed to the Slack webhook stub."""
    payloads = []

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")
        SlackStubHandler.payloads.append(json.loads(body))

    def log_message(self, *_): pass


class DiscordStubHandler(BaseHTTPRequestHandler):
    """Records payloads POSTed to the Discord webhook stub."""
    payloads = []

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        self.send_response(204)
        self.end_headers()
        DiscordStubHandler.payloads.append(json.loads(body))

    def log_message(self, *_): pass


class SMTPStub:
    """Minimal stub that records outbound emails."""
    sent = []

    def __init__(self, *a, **kw):
        pass

    def send_message(self, msg):
        SMTPStub.sent.append({"to": msg["To"], "subject": msg["Subject"], "body": str(msg)})

    def __enter__(self):
        return self

    def __exit__(self, *a):
        pass


# --- Import the application modules after stubs are ready ---

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.ingestion import create_ingestion_app
from app.rules import RuleEngine
from app.notifier import Notifier
from app.escalation import EscalationTracker


def _start_server(handler, port):
    server = HTTPServer(("127.0.0.1", port), handler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server


class EndToEndAlertFlowTest(unittest.TestCase):
    """Full integration: ingest event → evaluate rules → deliver notification → handle escalation."""

    @classmethod
    def setUpClass(cls):
        # Start stub servers on high ports
        cls._slack_srv = _start_server(SlackStubHandler, 19001)
        cls._discord_srv = _start_server(DiscordStubHandler, 19002)
        # Reset recorded payloads
        SlackStubHandler.payloads.clear()
        DiscordStubHandler.payloads.clear()
        SMTPStub.sent.clear()

    @classmethod
    def tearDownClass(cls):
        cls._slack_srv.shutdown()
        cls._discord_srv.shutdown()

    def setUp(self):
        self.config = {
            "slack_webhook_url": "http://127.0.0.1:19001/slack",
            "discord_webhook_url": "http://127.0.0.1:19002/discord",
            "email_smtp_host": "localhost",
            "email_smtp_port": 25,
            "email_from": "pulsealert@test",
            "escalation_delay_secs": 1,
        }
        self.rules = RuleEngine()
        self.notifier = Notifier(self.config)
        self.tracker = EscalationTracker(self.config, self.notifier)
        self.app = create_ingestion_app(self.rules, self.notifier, self.tracker)
        self.client = self.app.test_client()

    # --- helper ---
    def _post_event(self, event, expect_code=202):
        resp = self.client.post(
            "/events",
            data=json.dumps(event),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, expect_code, resp.data)
        return resp

    # --- tests ---

    def test_critical_event_triggers_slack_and_discord(self):
        event = {
            "service": "api-gateway",
            "status": "down",
            "severity": "critical",
            "message": "Health check failed 5/5",
            "timestamp": "2025-01-15T10:00:00Z",
        }
        self._post_event(event)
        # Both Slack and Discord should have received a notification
        self.assertTrue(len(SlackStubHandler.payloads) >= 1, "Slack should be notified for critical")
        self.assertTrue(len(DiscordStubHandler.payloads) >= 1, "Discord should be notified for critical")
        slack_msg = SlackStubHandler.payloads[-1].get("text", "")
        self.assertIn("critical", slack_msg.lower())

    @patch("app.notifier.smtplib.SMTP", new=SMTPStub)
    def test_warning_event_triggers_email_only(self):
        event = {
            "service": "auth-service",
            "status": "degraded",
            "severity": "warning",
            "message": "Latency > 2000ms",
            "timestamp": "2025-01-15T10:05:00Z",
        }
        self._post_event(event)
        self.assertTrue(len(SMTPStub.sent) >= 1, "Email should be sent for warning")
        self.assertIn("warning", SMTPStub.sent[-1]["subject"].lower())

    def test_info_event_is_acknowledged_but_no_notification(self):
        SlackStubHandler.payloads.clear()
        DiscordStubHandler.payloads.clear()
        event = {
            "service": "cron-jobs",
            "status": "healthy",
            "severity": "info",
            "message": "All checks passing",
            "timestamp": "2025-01-15T10:10:00Z",
        }
        self._post_event(event)
        self.assertEqual(len(SlackStubHandler.payloads), 0)
        self.assertEqual(len(DiscordStubHandler.payloads), 0)

    def test_invalid_payload_returns_400(self):
        resp = self.client.post(
            "/events",
            data="not-json",
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 400)

    @patch("app.notifier.smtplib.SMTP", new=SMTPStub)
    def test_escalation_sends_secondary_notification(self):
        event = {
            "service": "payment-svc",
            "status": "down",
            "severity": "critical",
            "message": "Connection refused",
            "timestamp": "2025-01-15T10:15:00Z",
        }
        self._post_event(event)
        # Manually trigger escalation check after delay
        time.sleep(1.2)
        self.tracker.check_escalations()
        # Escalation should have sent an additional notification
        notified_services = [
            p.get("text", "") for p in SlackStubHandler.payloads
        ]
        escalated = any("escalat" in n.lower() or "payment-svc" in n for n in notified_services[-2:])
        self.assertTrue(escalated, "Escalation should produce a follow-up notification")


class RuleEngineUnitTest(unittest.TestCase):
    """Verify rule evaluation logic in isolation."""

    def setUp(self):
        self.engine = RuleEngine()

    def test_critical_rule_matches(self):
        result = self.engine.evaluate({"severity": "critical", "status": "down"})
        self.assertEqual(result["channel"], "slack,discord,email")
        self.assertTrue(result["escalate"])

    def test_warning_rule_matches(self):
        result = self.engine.evaluate({"severity": "warning", "status": "degraded"})
        self.assertEqual(result["channel"], "email")
        self.assertFalse(result["escalate"])

    def test_info_rule_matches(self):
        result = self.engine.evaluate({"severity": "info", "status": "healthy"})
        self.assertEqual(result["channel"], "none")
        self.assertFalse(result["escalate"])


if __name__ == "__main__":
    unittest.main()