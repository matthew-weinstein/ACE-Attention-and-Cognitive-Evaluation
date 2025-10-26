"""
Replace the placeholder blink detection code in the
detect_blink() function with actual blink detection.

The script:
- Starts when it receives "START" command from the game
- Stops when it receives "STOP" command
- Logs blink events with timestamps to a file
- Communicates with the Electron app via stdin/stdout
"""

import sys
import json
import time
from datetime import datetime
import os
from eyetrax import GazeEstimator, run_9_point_calibration
import cv2

# Configuration
LOG_DIR = "blink_logs"
CAMERA_INDEX = 0  # Default webcam

class BlinkTracker:
    def __init__(self):
        self.is_tracking = False
        self.session_start_time = None
        self.log_file = None
        self.blink_count = 0
        self.estimator = None
        self.cap = None
        self.was_blinking = False
        
        # Clear all previous blink logs
        if os.path.exists(LOG_DIR):
            import shutil
            shutil.rmtree(LOG_DIR)
        
        # Create fresh log directory
        os.makedirs(LOG_DIR)
    
    def start_tracking(self, session_id):
        """Start tracking blinks for a session"""
        self.is_tracking = True
        self.session_start_time = time.time()
        self.blink_count = 0
        self.was_blinking = False
        
        # Create log file with timestamp
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        log_filename = f"{LOG_DIR}/blinks_{session_id}_{timestamp}.log"
        self.log_file = open(log_filename, 'w')
        
        # Write header
        self.log_file.write(f"Blink Tracking Session: {session_id}\n")
        self.log_file.write(f"Start Time: {datetime.now().isoformat()}\n")
        self.log_file.write("=" * 50 + "\n")
        self.log_file.write("Timestamp, Blink Number, Relative Time (s)\n")
        self.log_file.flush()
        
        # Initialize GazeEstimator and run calibration
        try:
            self.send_message("status", "calibrating", {"message": "Starting 9-point calibration..."})
            self.estimator = GazeEstimator()
            run_9_point_calibration(self.estimator)
            
            # Save calibration model
            self.estimator.save_model("gaze_model.pkl")
            
            # Initialize camera
            self.cap = cv2.VideoCapture(CAMERA_INDEX)
            
            self.send_message("status", "tracking_started", {"log_file": log_filename})
        except Exception as e:
            self.send_message("error", "initialization_failed", {"message": str(e)})
            self.is_tracking = False
            if self.log_file:
                self.log_file.close()
                self.log_file = None
            raise




    def stop_tracking(self):
        """Stop the current tracking session"""
        self.is_tracking = False
        
        if self.log_file:
            self.log_file.write("=" * 50 + "\n")
            self.log_file.write(f"End Time: {datetime.now().isoformat()}\n")
            self.log_file.write(f"Total Blinks: {self.blink_count}\n")
            self.log_file.close()
            self.log_file = None
        
        # Release camera and cleanup resources
        if self.cap is not None:
            self.cap.release()
            self.cap = None
        
        self.estimator = None
        self.was_blinking = False
        
        self.send_message("status", "tracking_stopped", {
            "total_blinks": self.blink_count,
            "duration_s": round((time.time() - self.session_start_time), 2) if self.session_start_time else 0
        })
    
    def detect_blink(self):
        """
        Detect blinks using eyetrax GazeEstimator
        Returns True if a blink is detected (transition from not blinking to blinking)
        """
        if self.cap is None or self.estimator is None:
            return False
        
        # Capture frame from camera
        ret, frame = self.cap.read()
        if not ret:
            return False
        
        try:
            # Extract features and blink status from frame
            features, blink = self.estimator.extract_features(frame)
            
            # Optional: Predict gaze coordinates when not blinking
            if features is not None and not blink:
                x, y = self.estimator.predict([features])[0]
                # Uncomment to see gaze coordinates:
                # print(f"Gaze: ({x:.0f}, {y:.0f})")
            
            # Only return True when transitioning from not blinking to blinking
            if blink and not self.was_blinking:
                self.was_blinking = True
                return True
            
            # Update previous state
            self.was_blinking = blink
            
        except Exception as e:
            # Log error but continue tracking
            self.send_message("error", "detection_error", {"message": str(e)})
        
        return False
    
    def log_blink(self):
        """Log a detected blink"""
        if not self.is_tracking or not self.log_file or self.session_start_time is None:
            return
        
        current_time = time.time()
        relative_time_s = round((current_time - self.session_start_time), 2)
        self.blink_count += 1
        
        # Write to log file
        timestamp = datetime.now().isoformat()
        log_line = f"{timestamp}, {self.blink_count}, {relative_time_s}\n"
        self.log_file.write(log_line)
        self.log_file.flush()
        
        # Send real-time update to game
        self.send_message("blink", "detected", {
            "blink_number": self.blink_count,
            "relative_time_s": relative_time_s,
            "timestamp": timestamp
        })
    
    def send_message(self, msg_type, action, data=None):
        """Send JSON message to the Electron app via stdout"""
        message = {
            "type": msg_type,
            "action": action,
            "data": data or {},
            "timestamp": datetime.now().isoformat()
        }
        print(json.dumps(message), flush=True)
    
    def run(self):
        """Main loop - listen for commands from Electron app"""
        self.send_message("status", "ready", {"message": "Blink tracker initialized"})
        
        try:
            for line in sys.stdin:
                try:
                    command = json.loads(line.strip())
                    action = command.get("action")
                    
                    if action == "START":
                        session_id = command.get("session_id", "default")
                        self.start_tracking(session_id)
                        
                        # Start tracking loop
                        while self.is_tracking:
                            # Check for blink
                            if self.detect_blink():
                                self.log_blink()
                            
                            # Small delay to prevent excessive CPU usage
                            time.sleep(0.01)  # Check ~100 times per second
                            
                            # Check for STOP command (non-blocking)
                            # Note: In production, use threading or async for better control
                    
                    elif action == "STOP":
                        self.stop_tracking()
                    
                    elif action == "PING":
                        self.send_message("status", "pong", {})
                    
                    elif action == "EXIT":
                        if self.is_tracking:
                            self.stop_tracking()
                        break
                
                except json.JSONDecodeError:
                    self.send_message("error", "invalid_command", {"message": "Invalid JSON"})
                except Exception as e:
                    self.send_message("error", "processing_error", {"message": str(e)})
        
        except KeyboardInterrupt:
            pass
        finally:
            if self.is_tracking:
                self.stop_tracking()
            self.send_message("status", "shutdown", {})

if __name__ == "__main__":
    tracker = BlinkTracker()
    tracker.run()
