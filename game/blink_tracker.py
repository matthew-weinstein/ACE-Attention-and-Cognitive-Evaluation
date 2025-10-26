"""
Blink Detection using MediaPipe and Eye Aspect Ratio (EAR) algorithm

The script:
- Starts when it receives "START" command from the game
- Stops when it receives "STOP" command
- Logs blink events with timestamps to a file
- Communicates with the Electron app via stdin/stdout
- Uses MediaPipe Face Mesh for robust eye tracking
- Implements EAR (Eye Aspect Ratio) algorithm for blink detection
"""

import sys
import json
import time
from datetime import datetime
import os
import cv2
import numpy as np
import mediapipe as mp
from scipy.spatial import distance

# Configuration
LOG_DIR = "blink_logs"
CAMERA_INDEX = 0  # Default webcam

# EAR (Eye Aspect Ratio) threshold for blink detection
EAR_THRESHOLD = 0.21  # Below this value indicates a blink
CONSEC_FRAMES = 2     # Consecutive frames below threshold to count as blink

# MediaPipe Face Mesh landmark indices for eyes
LEFT_EYE_INDICES = [33, 160, 158, 133, 153, 144]  # Left eye landmarks
RIGHT_EYE_INDICES = [362, 385, 387, 263, 373, 380]  # Right eye landmarks

class BlinkTracker:
    def __init__(self):
        self.is_tracking = False
        self.session_start_time = None
        self.log_file = None
        self.blink_count = 0
        self.cap = None
        self.face_mesh = None
        
        self.ear_values = []
        self.blink_counter = 0
        self.total_blinks = 0
        self.was_blinking = False
        
        if not os.path.exists(LOG_DIR):
            os.makedirs(LOG_DIR)
        
        self.mp_face_mesh = mp.solutions.face_mesh
    
    def calculate_ear(self, eye_landmarks):
        """Calculate Eye Aspect Ratio (EAR)"""
        A = distance.euclidean(eye_landmarks[1], eye_landmarks[5])
        B = distance.euclidean(eye_landmarks[2], eye_landmarks[4])
        C = distance.euclidean(eye_landmarks[0], eye_landmarks[3])
        ear = (A + B) / (2.0 * C)
        return ear
    
    def start_tracking(self, session_id):
        """Start tracking blinks for a session"""
        self.is_tracking = True
        self.session_start_time = time.time()
        self.blink_count = 0
        self.total_blinks = 0
        self.was_blinking = False
        self.blink_counter = 0
        self.ear_values = []
        
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        log_filename = f"{LOG_DIR}/blinks_{session_id}_{timestamp}.log"
        self.log_file = open(log_filename, 'w')
        
        self.log_file.write(f"Blink Tracking Session: {session_id}\n")
        self.log_file.write(f"Start Time: {datetime.now().isoformat()}\n")
        self.log_file.write(f"EAR Threshold: {EAR_THRESHOLD}\n")
        self.log_file.write("=" * 50 + "\n")
        self.log_file.write("Timestamp, Blink Number, Relative Time (s), EAR\n")
        self.log_file.flush()
        
        try:
            self.send_message("status", "initializing", {"message": "Starting blink detection..."})
            
            self.face_mesh = self.mp_face_mesh.FaceMesh(
                max_num_faces=1,
                refine_landmarks=True,
                min_detection_confidence=0.5,
                min_tracking_confidence=0.5
            )
            
            self.cap = cv2.VideoCapture(CAMERA_INDEX)
            
            if not self.cap.isOpened():
                raise Exception("Failed to open camera")
            
            self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
            self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
            self.cap.set(cv2.CAP_PROP_FPS, 30)
            
            self.send_message("status", "tracking_started", {"log_file": log_filename})
            
        except Exception as e:
            self.send_message("error", "initialization_failed", {"message": str(e)})
            self.is_tracking = False
            if self.log_file:
                self.log_file.close()
                self.log_file = None
            if self.face_mesh:
                self.face_mesh.close()
                self.face_mesh = None
            raise

    def stop_tracking(self):
        """Stop the current tracking session"""
        self.is_tracking = False
        
        if self.log_file:
            self.log_file.write("=" * 50 + "\n")
            self.log_file.write(f"End Time: {datetime.now().isoformat()}\n")
            self.log_file.write(f"Total Blinks: {self.total_blinks}\n")
            if self.ear_values:
                avg_ear = sum(self.ear_values) / len(self.ear_values)
                self.log_file.write(f"Average EAR: {avg_ear:.3f}\n")
            self.log_file.close()
            self.log_file = None
        
        if self.cap is not None:
            self.cap.release()
            self.cap = None
        
        if self.face_mesh is not None:
            self.face_mesh.close()
            self.face_mesh = None
        
        self.was_blinking = False
        self.blink_counter = 0
        
        self.send_message("status", "tracking_stopped", {
            "total_blinks": self.total_blinks,
            "duration_s": round((time.time() - self.session_start_time), 2) if self.session_start_time else 0
        })
    
    def detect_blink(self):
        """Detect blinks using MediaPipe Face Mesh and EAR"""
        if self.cap is None or self.face_mesh is None:
            return False, None
        
        ret, frame = self.cap.read()
        if not ret:
            return False, None
        
        try:
            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            results = self.face_mesh.process(rgb_frame)
            
            if not results.multi_face_landmarks:
                return False, None
            
            face_landmarks = results.multi_face_landmarks[0]
            h, w = frame.shape[:2]
            
            left_eye = []
            right_eye = []
            
            for idx in LEFT_EYE_INDICES:
                landmark = face_landmarks.landmark[idx]
                left_eye.append([landmark.x * w, landmark.y * h])
            
            for idx in RIGHT_EYE_INDICES:
                landmark = face_landmarks.landmark[idx]
                right_eye.append([landmark.x * w, landmark.y * h])
            
            left_eye = np.array(left_eye)
            right_eye = np.array(right_eye)
            
            left_ear = self.calculate_ear(left_eye)
            right_ear = self.calculate_ear(right_eye)
            
            ear = (left_ear + right_ear) / 2.0
            self.ear_values.append(ear)
            
            if ear < EAR_THRESHOLD:
                self.blink_counter += 1
            else:
                if self.blink_counter >= CONSEC_FRAMES:
                    self.total_blinks += 1
                    self.blink_counter = 0
                    return True, ear
                self.blink_counter = 0
            
            return False, ear
            
        except Exception as e:
            self.send_message("error", "detection_error", {"message": str(e)})
            return False, None
    
    def log_blink(self, ear_value=None):
        """Log a detected blink"""
        if not self.is_tracking or not self.log_file or self.session_start_time is None:
            return
        
        current_time = time.time()
        relative_time_s = round((current_time - self.session_start_time), 2)
        self.blink_count += 1
        
        timestamp = datetime.now().isoformat()
        ear_str = f", {ear_value:.3f}" if ear_value is not None else ", N/A"
        log_line = f"{timestamp}, {self.blink_count}, {relative_time_s}{ear_str}\n"
        self.log_file.write(log_line)
        self.log_file.flush()
        
        self.send_message("blink", "detected", {
            "blink_number": self.blink_count,
            "relative_time_s": relative_time_s,
            "relative_time_ms": int(relative_time_s * 1000),
            "timestamp": timestamp,
            "ear": ear_value
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
                        
                        while self.is_tracking:
                            blink_detected, ear = self.detect_blink()
                            if blink_detected:
                                self.log_blink(ear)
                            
                            time.sleep(0.033)
                    
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
