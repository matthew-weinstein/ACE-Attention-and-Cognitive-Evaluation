"""
Head Tracker - stub.
Camera and face detection now consolidated in eye_tracker.py to avoid
Windows camera contention. This process just handles lifecycle commands.
"""

import sys
import json
from datetime import datetime

def send(msg_type, action, data=None):
    print(json.dumps({
        "type": msg_type,
        "action": action,
        "data": data or {},
        "timestamp": datetime.now().isoformat()
    }), flush=True)

send("status", "ready", {"message": "Head tracker ready"})

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        cmd    = json.loads(line)
        action = cmd.get("action")
        if action == "START":
            send("status", "tracking_started", {"session_id": cmd.get("session_id", "default")})
        elif action == "STOP":
            send("status", "tracking_stopped", {"total_blinks": 0})
        elif action == "CALIBRATE":
            send("status", "calibrated", {"message": "Head pose calibrated"})
        elif action == "PING":
            send("status", "pong", {})
        elif action == "EXIT":
            break
    except Exception:
        pass

send("status", "shutdown", {})
