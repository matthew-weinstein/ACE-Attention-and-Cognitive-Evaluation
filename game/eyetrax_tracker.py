"""
EyeTrax Eye Tracking Integration
Handles calibration and real-time gaze tracking for the ACE game.
"""

import sys
import json
import time
import os
import cv2
import numpy as np
from datetime import datetime

from eyetrax.calibration import run_9_point_calibration
from eyetrax.filters import KalmanSmoother, make_kalman
from eyetrax.gaze import GazeEstimator
from eyetrax.utils.screen import get_screen_size
from eyetrax.utils.video import camera, iter_frames

# Configuration
LOG_DIR = "blink_logs"
CAMERA_INDEX = 0
MODEL_NAME = "svr"  # Options: 'elastic_net', 'linear_svr', 'ridge', 'svr', 'tiny_mlp'

class EyeTraxTracker:
    def __init__(self):
        self.is_tracking = False
        self.is_calibrated = False
        self.session_start_time = None
        self.log_file = None
        self.blink_count = 0
        self.gaze_count = 0
        
        # EyeTrax components
        self.gaze_estimator = None
        self.smoother = None
        self.cap = None
        self.screen_width = None
        self.screen_height = None
        
        # Calibration state
        self.calibration_in_progress = False
        
        # Ensure log directory exists
        if not os.path.exists(LOG_DIR):
            os.makedirs(LOG_DIR)
    
    def initialize_camera(self):
        """Initialize the camera"""
        try:
            self.cap = cv2.VideoCapture(CAMERA_INDEX)
            if not self.cap.isOpened():
                raise Exception("Failed to open camera")
            
            # Set camera properties for better performance
            self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
            self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
            self.cap.set(cv2.CAP_PROP_FPS, 30)
            
            return True
        except Exception as e:
            self.send_message("error", "camera_init_failed", {"message": str(e)})
            return False
    
    def run_calibration(self):
        """Run 5-point calibration routine"""
        try:
            self.calibration_in_progress = True
            self.send_message("calibration", "started", {})
            
            # Initialize gaze estimator
            self.gaze_estimator = GazeEstimator(model_name=MODEL_NAME)
            
            # Get screen size
            self.screen_width, self.screen_height = get_screen_size()
            
            # Run calibration
            self.send_message("calibration", "instruction", {
                "message": "Look at the green dot and keep your eyes open when the white circle runs out"
            })
            
            # Run the 5-point calibration (this opens and uses the camera)
            run_9_point_calibration(self.gaze_estimator, camera_index=CAMERA_INDEX)
            
            # Setup Kalman filter for smoothing
            kalman = make_kalman()
            self.smoother = KalmanSmoother(kalman)
            self.smoother.tune(self.gaze_estimator, camera_index=CAMERA_INDEX)
            
            # Keep camera open for tracking (initialize it now so it's ready)
            if self.cap is None or not self.cap.isOpened():
                self.initialize_camera()
            
            self.is_calibrated = True
            self.calibration_in_progress = False
            
            self.send_message("calibration", "completed", {
                "screen_width": self.screen_width,
                "screen_height": self.screen_height
            })
            
            return True
            
        except Exception as e:
            self.calibration_in_progress = False
            self.send_message("error", "calibration_failed", {"message": str(e)})
            return False
    
    def start_tracking(self, session_id):
        """Start a new eye tracking session"""
        if not self.is_calibrated:
            self.send_message("error", "not_calibrated", {
                "message": "Please run calibration first"
            })
            return False
        
        try:
            self.is_tracking = True
            self.session_start_time = time.time()
            self.blink_count = 0
            self.gaze_count = 0
            
            # Create log file with timestamp
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            log_filename = f"{LOG_DIR}/eyetracking_{session_id}_{timestamp}.log"
            self.log_file = open(log_filename, 'w')
            
            # Write header
            self.log_file.write(f"Eye Tracking Session: {session_id}\n")
            self.log_file.write(f"Start Time: {datetime.now().isoformat()}\n")
            self.log_file.write(f"Screen Size: {self.screen_width}x{self.screen_height}\n")
            self.log_file.write("=" * 80 + "\n")
            self.log_file.write("Timestamp,Type,X,Y,RelativeTime(ms),EventNumber\n")
            self.log_file.flush()
            
            # Camera should already be open from calibration
            # But double-check just in case
            if self.cap is None or not self.cap.isOpened():
                self.send_message("status", "initializing_camera", {"message": "Opening camera..."})
                if not self.initialize_camera():
                    return False
            
            self.send_message("status", "tracking_started", {
                "log_file": log_filename,
                "session_id": session_id
            })
            
            return True
            
        except Exception as e:
            self.send_message("error", "start_failed", {"message": str(e)})
            return False
    
    def stop_tracking(self):
        """Stop the current tracking session"""
        self.is_tracking = False
        
        if self.log_file:
            self.log_file.write("=" * 80 + "\n")
            self.log_file.write(f"End Time: {datetime.now().isoformat()}\n")
            self.log_file.write(f"Total Blinks: {self.blink_count}\n")
            self.log_file.write(f"Total Gaze Points: {self.gaze_count}\n")
            self.log_file.close()
            self.log_file = None
        
        duration_ms = int((time.time() - self.session_start_time) * 1000) if self.session_start_time else 0
        
        self.send_message("status", "tracking_stopped", {
            "total_blinks": self.blink_count,
            "total_gaze_points": self.gaze_count,
            "duration_ms": duration_ms
        })
    
    def process_frame(self):
        """Process a single frame for gaze and blink detection"""
        if not self.is_tracking or self.cap is None:
            return
        
        try:
            ret, frame = self.cap.read()
            if not ret:
                return
            
            # Extract features and check for blink
            features, blink_detected = self.gaze_estimator.extract_features(frame)
            
            current_time = time.time()
            relative_time_ms = int((current_time - self.session_start_time) * 1000)
            timestamp = datetime.now().isoformat()
            
            # Handle blink detection
            if blink_detected:
                self.blink_count += 1
                
                # Log to file
                if self.log_file:
                    log_line = f"{timestamp},BLINK,-1,-1,{relative_time_ms},{self.blink_count}\n"
                    self.log_file.write(log_line)
                    self.log_file.flush()
                
                # Send to renderer
                self.send_message("blink", "detected", {
                    "blink_number": self.blink_count,
                    "relative_time_ms": relative_time_ms,
                    "timestamp": timestamp
                })
            
            # Handle gaze prediction
            if features is not None and not blink_detected:
                gaze_point = self.gaze_estimator.predict(np.array([features]))[0]
                x, y = map(int, gaze_point)
                
                # Apply smoothing
                x_pred, y_pred = self.smoother.step(x, y)
                
                # Ensure coordinates are within screen bounds
                x_pred = max(0, min(self.screen_width, x_pred))
                y_pred = max(0, min(self.screen_height, y_pred))
                
                self.gaze_count += 1
                
                # Log to file (log every 10th gaze point to reduce file size)
                if self.log_file and self.gaze_count % 10 == 0:
                    log_line = f"{timestamp},GAZE,{x_pred},{y_pred},{relative_time_ms},{self.gaze_count}\n"
                    self.log_file.write(log_line)
                    self.log_file.flush()
                
                # Send to renderer (send all gaze points for real-time display)
                self.send_message("gaze", "detected", {
                    "x": x_pred,
                    "y": y_pred,
                    "relative_time_ms": relative_time_ms,
                    "timestamp": timestamp,
                    "screen_width": self.screen_width,
                    "screen_height": self.screen_height
                })
            
        except Exception as e:
            self.send_message("error", "processing_frame", {"message": str(e)})
    
    def send_message(self, msg_type, action, data=None):
        """Send JSON message to the Electron app via stdout"""
        message = {
            "type": msg_type,
            "action": action,
            "data": data or {},
            "timestamp": datetime.now().isoformat()
        }
        print(json.dumps(message), flush=True)
    
    def cleanup(self):
        """Clean up resources"""
        if self.is_tracking:
            self.stop_tracking()
        
        if self.cap is not None:
            self.cap.release()
            self.cap = None
        
        cv2.destroyAllWindows()
    
    def run(self):
        """Main loop - listen for commands from Electron app"""
        self.send_message("status", "ready", {"message": "EyeTrax tracker initialized"})
        
        try:
            for line in sys.stdin:
                try:
                    command = json.loads(line.strip())
                    action = command.get("action")
                    
                    if action == "CALIBRATE":
                        # Run calibration
                        self.run_calibration()
                    
                    elif action == "START":
                        session_id = command.get("session_id", "default")
                        if self.start_tracking(session_id):
                            # Start tracking loop
                            while self.is_tracking:
                                self.process_frame()
                                
                                # Small delay to prevent excessive CPU usage
                                time.sleep(0.01)  # ~100 FPS max
                    
                    elif action == "STOP":
                        self.stop_tracking()
                    
                    elif action == "PING":
                        self.send_message("status", "pong", {
                            "calibrated": self.is_calibrated,
                            "tracking": self.is_tracking
                        })
                    
                    elif action == "EXIT":
                        break
                
                except json.JSONDecodeError:
                    self.send_message("error", "invalid_command", {"message": "Invalid JSON"})
                except Exception as e:
                    self.send_message("error", "processing_error", {"message": str(e)})
        
        except KeyboardInterrupt:
            pass
        finally:
            self.cleanup()
            self.send_message("status", "shutdown", {})

if __name__ == "__main__":
    tracker = EyeTraxTracker()
    tracker.run()
