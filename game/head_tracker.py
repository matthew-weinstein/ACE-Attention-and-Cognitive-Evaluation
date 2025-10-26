"""
Head Tracking Script for Attention Assessment
Runs headless and communicates with Electron app via stdin/stdout
Includes both head pose tracking and blink detection
"""

import sys
import json
import time
from datetime import datetime
import os
import cv2 as cv
import numpy as np
import mediapipe as mp
import collections
from scipy.spatial import distance

# Configuration
LOG_DIR = "head_logs"
CAMERA_INDEX = 0  # Default webcam

USER_FACE_WIDTH = 140
MIN_DETECTION_CONFIDENCE = 0.8
MIN_TRACKING_CONFIDENCE = 0.8
MOVING_AVERAGE_WINDOW = 10

# MediaPipe Face Mesh Indices for Head Pose
NOSE_TIP_INDEX = 4
CHIN_INDEX = 152
LEFT_EYE_LEFT_CORNER_INDEX = 33
RIGHT_EYE_RIGHT_CORNER_INDEX = 263
LEFT_MOUTH_CORNER_INDEX = 61
RIGHT_MOUTH_CORNER_INDEX = 291

# MediaPipe Face Mesh Indices for Blink Detection (EAR algorithm)
LEFT_EYE_INDICES = [33, 160, 158, 133, 153, 144]  # Left eye landmarks
RIGHT_EYE_INDICES = [362, 385, 387, 263, 373, 380]  # Right eye landmarks

# Blink detection parameters
EAR_THRESHOLD = 0.21  # Below this value indicates a blink
CONSEC_FRAMES = 2     # Consecutive frames below threshold to count as blink

class AngleBuffer:
    def __init__(self, size=40):
        self.size = size
        self.buffer = collections.deque(maxlen=size)

    def add(self, angles):
        self.buffer.append(angles)

    def get_average(self):
        return np.mean(self.buffer, axis=0)


class HeadTracker:
    def __init__(self):
        self.is_tracking = False
        self.session_start_time = None
        self.log_file = None
        self.blink_log_file = None  # Separate log for blinks
        self.cap = None
        self.mp_face_mesh = None
        self.angle_buffer = None
        self.initial_pitch = None
        self.initial_yaw = None
        self.initial_roll = None
        self.calibrated = False
        
        # Blink detection state
        self.blink_counter = 0
        self.total_blinks = 0
        self.blink_count = 0
        self.ear_values = []
        
        # Create log directories
        if not os.path.exists(LOG_DIR):
            os.makedirs(LOG_DIR)
        if not os.path.exists("blink_logs"):
            os.makedirs("blink_logs")
    
    def normalize_pitch(self, pitch):
        """Normalize pitch angle"""
        if pitch > 180:
            pitch -= 360
        pitch = -pitch
        if pitch < -90:
            pitch = -(180 + pitch)
        elif pitch > 90:
            pitch = 180 - pitch
        pitch = -pitch
        return pitch
    
    def calculate_ear(self, eye_landmarks):
        """
        Calculate Eye Aspect Ratio (EAR) for blink detection
        EAR = (||p2-p6|| + ||p3-p5||) / (2 * ||p1-p4||)
        """
        # Vertical eye distances
        A = distance.euclidean(eye_landmarks[1], eye_landmarks[5])
        B = distance.euclidean(eye_landmarks[2], eye_landmarks[4])
        
        # Horizontal eye distance
        C = distance.euclidean(eye_landmarks[0], eye_landmarks[3])
        
        # EAR calculation
        ear = (A + B) / (2.0 * C)
        return ear
    
    def estimate_head_pose(self, landmarks, image_size):
        """Estimate head pose from facial landmarks"""
        scale_factor = USER_FACE_WIDTH / 150.0
        
        model_points = np.array([
            (0.0, 0.0, 0.0),
            (0.0, -330.0 * scale_factor, -65.0 * scale_factor),
            (-225.0 * scale_factor, 170.0 * scale_factor, -135.0 * scale_factor),
            (225.0 * scale_factor, 170.0 * scale_factor, -135.0 * scale_factor),
            (-150.0 * scale_factor, -150.0 * scale_factor, -125.0 * scale_factor),
            (150.0 * scale_factor, -150.0 * scale_factor, -125.0 * scale_factor)
        ])
        
        focal_length = image_size[1]
        center = (image_size[1]/2, image_size[0]/2)
        camera_matrix = np.array([
            [focal_length, 0, center[0]],
            [0, focal_length, center[1]],
            [0, 0, 1]
        ], dtype="double")
        
        dist_coeffs = np.zeros((4,1))
        
        image_points = np.array([
            landmarks[NOSE_TIP_INDEX],
            landmarks[CHIN_INDEX],
            landmarks[LEFT_EYE_LEFT_CORNER_INDEX],
            landmarks[RIGHT_EYE_RIGHT_CORNER_INDEX],
            landmarks[LEFT_MOUTH_CORNER_INDEX],
            landmarks[RIGHT_MOUTH_CORNER_INDEX]
        ], dtype="double")
        
        success, rotation_vector, translation_vector = cv.solvePnP(
            model_points, image_points, camera_matrix, dist_coeffs, 
            flags=cv.SOLVEPNP_ITERATIVE
        )
        
        rotation_matrix, _ = cv.Rodrigues(rotation_vector)
        projection_matrix = np.hstack((rotation_matrix, translation_vector.reshape(-1, 1)))
        _, _, _, _, _, _, euler_angles = cv.decomposeProjectionMatrix(projection_matrix)
        pitch, yaw, roll = euler_angles.flatten()[:3]
        pitch = self.normalize_pitch(pitch)
        
        return pitch, yaw, roll
    
    def start_tracking(self, session_id):
        """Start tracking head pose and blinks for a session"""
        self.is_tracking = True
        self.session_start_time = time.time()
        self.calibrated = False
        self.initial_pitch = None
        self.initial_yaw = None
        self.initial_roll = None
        self.angle_buffer = AngleBuffer(size=MOVING_AVERAGE_WINDOW)
        
        # Reset blink detection state
        self.blink_counter = 0
        self.total_blinks = 0
        self.blink_count = 0
        self.ear_values = []
        
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        
        # Create head pose log
        log_filename = f"{LOG_DIR}/head_pose_{session_id}_{timestamp}.log"
        self.log_file = open(log_filename, 'w')
        self.log_file.write(f"Head Tracking Session: {session_id}\n")
        self.log_file.write(f"Start Time: {datetime.now().isoformat()}\n")
        self.log_file.write("=" * 50 + "\n")
        self.log_file.write("Timestamp (ms), Pitch, Yaw, Roll, Direction\n")
        self.log_file.flush()
        
        # Create blink log
        blink_log_filename = f"blink_logs/blinks_{session_id}_{timestamp}.log"
        self.blink_log_file = open(blink_log_filename, 'w')
        self.blink_log_file.write(f"Blink Tracking Session: {session_id}\n")
        self.blink_log_file.write(f"Start Time: {datetime.now().isoformat()}\n")
        self.blink_log_file.write(f"EAR Threshold: {EAR_THRESHOLD}\n")
        self.blink_log_file.write("=" * 50 + "\n")
        self.blink_log_file.write("Timestamp, Blink Number, Relative Time (s), EAR\n")
        self.blink_log_file.flush()
        
        if self.mp_face_mesh is None:
            self.mp_face_mesh = mp.solutions.face_mesh.FaceMesh(
                max_num_faces=1,
                refine_landmarks=True,
                min_detection_confidence=MIN_DETECTION_CONFIDENCE,
                min_tracking_confidence=MIN_TRACKING_CONFIDENCE,
            )
        
        try:
            self.cap = cv.VideoCapture(CAMERA_INDEX)
            if not self.cap.isOpened():
                raise Exception("Failed to open camera")
            
            self.send_message("status", "tracking_started", {
                "log_file": log_filename,
                "blink_log_file": blink_log_filename
            })
        except Exception as e:
            self.send_message("error", "initialization_failed", {"message": str(e)})
            self.is_tracking = False
            if self.log_file:
                self.log_file.close()
                self.log_file = None
            if self.blink_log_file:
                self.blink_log_file.close()
                self.blink_log_file = None
            raise
    
    def stop_tracking(self):
        """Stop the current tracking session"""
        self.is_tracking = False
        
        # Close logs
        if self.log_file:
            self.log_file.write("=" * 50 + "\n")
            self.log_file.write(f"End Time: {datetime.now().isoformat()}\n")
            self.log_file.close()
            self.log_file = None
        
        if self.blink_log_file:
            self.blink_log_file.write("=" * 50 + "\n")
            self.blink_log_file.write(f"End Time: {datetime.now().isoformat()}\n")
            self.blink_log_file.write(f"Total Blinks: {self.total_blinks}\n")
            if self.ear_values:
                avg_ear = sum(self.ear_values) / len(self.ear_values)
                self.blink_log_file.write(f"Average EAR: {avg_ear:.3f}\n")
            self.blink_log_file.close()
            self.blink_log_file = None
        
        if self.cap is not None:
            self.cap.release()
            self.cap = None
        
        if self.mp_face_mesh is not None:
            self.mp_face_mesh.close()
            self.mp_face_mesh = None
        
        self.send_message("status", "tracking_stopped", {
            "duration_s": round((time.time() - self.session_start_time), 2) if self.session_start_time else 0,
            "total_blinks": self.total_blinks
        })
    
    def process_frame(self):
        """Process a single frame and detect head pose and blinks"""
        if self.cap is None or self.mp_face_mesh is None:
            return
        
        ret, frame = self.cap.read()
        if not ret:
            return
        
        rgb_frame = cv.cvtColor(frame, cv.COLOR_BGR2RGB)
        img_h, img_w = frame.shape[:2]
        results = self.mp_face_mesh.process(rgb_frame)
        
        if results.multi_face_landmarks:
            face_landmarks = results.multi_face_landmarks[0]
            
            mesh_points = np.array([
                np.multiply([p.x, p.y], [img_w, img_h]).astype(int)
                for p in face_landmarks.landmark
            ])
            
            # Detect head pose
            pitch, yaw, roll = self.estimate_head_pose(mesh_points, (img_h, img_w))
            self.angle_buffer.add([pitch, yaw, roll])
            pitch, yaw, roll = self.angle_buffer.get_average()
            
            if self.initial_pitch is None:
                self.initial_pitch, self.initial_yaw, self.initial_roll = pitch, yaw, roll
                self.calibrated = True
                self.send_message("status", "calibrated", {"message": "Initial calibration complete"})
            
            if self.calibrated:
                pitch_adjusted = pitch - self.initial_pitch
                yaw_adjusted = yaw - self.initial_yaw
                roll_adjusted = roll - self.initial_roll
            else:
                pitch_adjusted = pitch
                yaw_adjusted = yaw
                roll_adjusted = roll
            
            threshold = 10
            if yaw_adjusted < -threshold:
                direction = "Left"
            elif yaw_adjusted > threshold:
                direction = "Right"
            elif pitch_adjusted < -threshold:
                direction = "Down"
            elif pitch_adjusted > threshold:
                direction = "Up"
            else:
                direction = "Forward"
            
            if self.log_file:
                timestamp = int(time.time() * 1000)
                log_line = f"{timestamp}, {pitch_adjusted:.2f}, {yaw_adjusted:.2f}, {roll_adjusted:.2f}, {direction}\n"
                self.log_file.write(log_line)
                self.log_file.flush()
            
            self.send_message("head_pose", "detected", {
                "pitch": round(pitch_adjusted, 2),
                "yaw": round(yaw_adjusted, 2),
                "roll": round(roll_adjusted, 2),
                "direction": direction,
                "timestamp": datetime.now().isoformat()
            })
            
            # Detect blinks
            left_eye = []
            right_eye = []
            
            for idx in LEFT_EYE_INDICES:
                landmark = face_landmarks.landmark[idx]
                left_eye.append([landmark.x * img_w, landmark.y * img_h])
            
            for idx in RIGHT_EYE_INDICES:
                landmark = face_landmarks.landmark[idx]
                right_eye.append([landmark.x * img_w, landmark.y * img_h])
            
            left_eye = np.array(left_eye)
            right_eye = np.array(right_eye)
            
            left_ear = self.calculate_ear(left_eye)
            right_ear = self.calculate_ear(right_eye)
            
            ear = (left_ear + right_ear) / 2.0
            self.ear_values.append(ear)
            
            blink_detected = False
            if ear < EAR_THRESHOLD:
                self.blink_counter += 1
            else:
                if self.blink_counter >= CONSEC_FRAMES:
                    self.total_blinks += 1
                    self.blink_count += 1
                    blink_detected = True
                    current_time = time.time()
                    relative_time_s = round((current_time - self.session_start_time), 2)
                    
                    if self.blink_log_file:
                        timestamp_str = datetime.now().isoformat()
                        log_line = f"{timestamp_str}, {self.blink_count}, {relative_time_s}, {ear:.3f}\n"
                        self.blink_log_file.write(log_line)
                        self.blink_log_file.flush()
                    
                    self.send_message("blink", "detected", {
                        "blink_number": self.blink_count,
                        "relative_time_s": relative_time_s,
                        "relative_time_ms": int(relative_time_s * 1000),
                        "timestamp": datetime.now().isoformat(),
                        "ear": round(ear, 3)
                    })
                
                self.blink_counter = 0
    
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
        self.send_message("status", "ready", {"message": "Head tracker initialized"})
        
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
                            self.process_frame()
                            
                            # Small delay to prevent excessive CPU usage
                            time.sleep(0.033)  # ~30 FPS
                    
                    elif action == "STOP":
                        self.stop_tracking()
                    
                    elif action == "CALIBRATE":
                        # Recalibrate head pose
                        if self.angle_buffer is not None and len(self.angle_buffer.buffer) > 0:
                            pitch, yaw, roll = self.angle_buffer.get_average()
                            self.initial_pitch, self.initial_yaw, self.initial_roll = pitch, yaw, roll
                            self.send_message("status", "recalibrated", {"message": "Head pose recalibrated"})
                    
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
            
            # Cleanup MediaPipe
            if self.mp_face_mesh:
                self.mp_face_mesh.close()
            
            self.send_message("status", "shutdown", {})

if __name__ == "__main__":
    tracker = HeadTracker()
    tracker.run()

