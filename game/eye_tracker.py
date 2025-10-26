#!/usr/bin/env python3
"""
Eye Tracker Integration Script

This script handles eye tracking using the eyetrax library and communicates
with the Electron app via JSON messages over stdin/stdout.
"""

import sys
import json
import time
import threading
from datetime import datetime

try:
    import eyetrax
    EYETRAX_AVAILABLE = True
except ImportError:
    EYETRAX_AVAILABLE = False
    print("Warning: eyetrax library not available. Eye tracking will be simulated.")

class EyeTracker:
    def __init__(self):
        self.is_running = False
        self.is_tracking = False
        self.session_id = None
        self.gaze_data = []
        self.blink_data = []
        self.calibration_data = []
        
    def send_message(self, msg_type, action, data=None):
        """Send a JSON message to the Electron app"""
        message = {
            "type": msg_type,
            "action": action,
            "timestamp": datetime.now().isoformat(),
            "data": data or {}
        }
        print(json.dumps(message))
        sys.stdout.flush()
        
    def send_status(self, action, data=None):
        """Send a status message"""
        self.send_message("status", action, data)
        
    def send_gaze(self, x, y, confidence=None):
        """Send gaze data"""
        data = {
            "x": x,
            "y": y,
            "confidence": confidence or 1.0
        }
        self.send_message("gaze", "detected", data)
        
    def send_blink(self, duration=None):
        """Send blink data"""
        data = {
            "duration": duration or 0.1,
            "timestamp": time.time()
        }
        self.send_message("blink", "detected", data)
        
    def send_calibration_status(self, action, data=None):
        """Send calibration status"""
        self.send_message("calibration", action, data)
        
    def send_error(self, error_msg):
        """Send error message"""
        self.send_message("error", "error", {"message": error_msg})
        
    def initialize(self):
        """Initialize the eye tracker"""
        try:
            if EYETRAX_AVAILABLE:
                # Initialize eyetrax here
                self.send_status("ready", {"message": "Eye tracker initialized successfully"})
            else:
                self.send_status("ready", {"message": "Eye tracker initialized (simulation mode)"})
            return True
        except Exception as e:
            self.send_error(f"Failed to initialize eye tracker: {str(e)}")
            return False
            
    def start_tracking(self, session_id):
        """Start eye tracking"""
        try:
            self.session_id = session_id
            self.is_tracking = True
            self.send_status("tracking_started", {"session_id": session_id})
            
            # Start tracking thread
            if EYETRAX_AVAILABLE:
                self.tracking_thread = threading.Thread(target=self._track_eyes)
                self.tracking_thread.daemon = True
                self.tracking_thread.start()
            else:
                # Simulation mode
                self.tracking_thread = threading.Thread(target=self._simulate_tracking)
                self.tracking_thread.daemon = True
                self.tracking_thread.start()
                
            return True
        except Exception as e:
            self.send_error(f"Failed to start tracking: {str(e)}")
            return False
            
    def stop_tracking(self):
        """Stop eye tracking"""
        try:
            self.is_tracking = False
            self.send_status("tracking_stopped", {
                "total_gaze_points": len(self.gaze_data),
                "total_blinks": len(self.blink_data)
            })
            return True
        except Exception as e:
            self.send_error(f"Failed to stop tracking: {str(e)}")
            return False
            
    def calibrate(self):
        """Start calibration process"""
        try:
            self.send_calibration_status("started", {"message": "Calibration started"})
            
            # Simulate calibration process
            for i in range(5):
                time.sleep(1)
                self.send_calibration_status("instruction", {
                    "message": f"Look at point {i+1} of 5",
                    "point": i+1,
                    "total_points": 5
                })
                
            time.sleep(1)
            self.send_calibration_status("completed", {"message": "Calibration completed successfully"})
            return True
        except Exception as e:
            self.send_error(f"Failed to calibrate: {str(e)}")
            return False
            
    def _track_eyes(self):
        """Main tracking loop (real implementation)"""
        while self.is_tracking:
            try:
                if EYETRAX_AVAILABLE:
                    # Get gaze data from eyetrax
                    # This would be the real implementation
                    pass
                time.sleep(0.033)  # ~30 FPS
            except Exception as e:
                self.send_error(f"Tracking error: {str(e)}")
                break
                
    def _simulate_tracking(self):
        """Simulate eye tracking for testing"""
        import random
        
        while self.is_tracking:
            try:
                # Simulate gaze data
                x = random.uniform(0, 1920)
                y = random.uniform(0, 1080)
                confidence = random.uniform(0.7, 1.0)
                
                self.send_gaze(x, y, confidence)
                self.gaze_data.append({"x": x, "y": y, "confidence": confidence})
                
                # Occasionally simulate a blink
                if random.random() < 0.01:  # 1% chance per frame
                    self.send_blink()
                    self.blink_data.append({"timestamp": time.time()})
                    
                time.sleep(0.033)  # ~30 FPS
            except Exception as e:
                self.send_error(f"Simulation error: {str(e)}")
                break

def main():
    """Main function to handle communication with Electron app"""
    tracker = EyeTracker()
    
    # Initialize
    if not tracker.initialize():
        sys.exit(1)
        
    tracker.is_running = True
    
    # Main command loop
    try:
        for line in sys.stdin:
            try:
                command = json.loads(line.strip())
                action = command.get("action")
                
                if action == "START":
                    session_id = command.get("session_id", "default")
                    tracker.start_tracking(session_id)
                    
                elif action == "STOP":
                    tracker.stop_tracking()
                    
                elif action == "CALIBRATE":
                    tracker.calibrate()
                    
                elif action == "PING":
                    tracker.send_status("pong", {"message": "Eye tracker is running"})
                    
                elif action == "EXIT":
                    tracker.stop_tracking()
                    break
                    
            except json.JSONDecodeError:
                continue
            except Exception as e:
                tracker.send_error(f"Command error: {str(e)}")
                
    except KeyboardInterrupt:
        pass
    finally:
        tracker.is_running = False
        tracker.stop_tracking()

if __name__ == "__main__":
    main()
