"""
Head Pose Estimation - Yaw and Pitch Tracker

Real-time head pose estimation (yaw and pitch tracking) using MediaPipe FaceMesh.

Features:
- Real-time head pose estimation (pitch, yaw, roll angles)
- Calibration feature to set initial head pose as reference
- Data logging for analysis
- Visual feedback with direction indicator

Requirements:
- Python 3.x
- OpenCV (opencv-python)
- MediaPipe (mediapipe)
- NumPy

Usage:
- Run: python main.py
- Press 'c' to calibrate head pose to current orientation
- Press 'r' to start/stop logging
- Press 'q' to exit
"""

import cv2 as cv
import numpy as np
import mediapipe as mp
import argparse
import time
import csv
from datetime import datetime
import os
from AngleBuffer import AngleBuffer

#-----------------------------------------------------------------------------------------------------------------------------------
# CONFIGURATION PARAMETERS
#-----------------------------------------------------------------------------------------------------------------------------------

# User-Specific Measurements
USER_FACE_WIDTH = 140  # [mm] - Measure your face width and adjust

# Configuration
PRINT_DATA = True  # Enable console output
DEFAULT_WEBCAM = 0  # Default camera index
SHOW_ON_SCREEN_DATA = True  # Display angles on screen
LOG_DATA = True  # Enable CSV logging
LOG_FOLDER = "logs"  # Log file directory
IS_RECORDING = False  # Start recording immediately (False = wait for 'r' key)

# MediaPipe Confidence Parameters
MIN_DETECTION_CONFIDENCE = 0.8
MIN_TRACKING_CONFIDENCE = 0.8

# Smoothing Parameters
MOVING_AVERAGE_WINDOW = 10  # Frames for moving average

# Head Pose Landmark Indices (MediaPipe 468 landmarks)
NOSE_TIP_INDEX = 4
CHIN_INDEX = 152
LEFT_EYE_LEFT_CORNER_INDEX = 33
RIGHT_EYE_RIGHT_CORNER_INDEX = 263
LEFT_MOUTH_CORNER_INDEX = 61
RIGHT_MOUTH_CORNER_INDEX = 291

# Eye/Iris Landmark Indices (for visual feedback)
LEFT_EYE_IRIS = [474, 475, 476, 477]
RIGHT_EYE_IRIS = [469, 470, 471, 472]
LEFT_EYE_OUTER_CORNER = [33]
LEFT_EYE_INNER_CORNER = [133]
RIGHT_EYE_OUTER_CORNER = [362]
RIGHT_EYE_INNER_CORNER = [263]

# Calibration variables
initial_pitch, initial_yaw, initial_roll = None, None, None
calibrated = False

#-----------------------------------------------------------------------------------------------------------------------------------
# FUNCTIONS
#-----------------------------------------------------------------------------------------------------------------------------------

def estimate_head_pose(landmarks, image_size):
    """
    Estimate head pose (pitch, yaw, roll) using solvePnP algorithm.
    
    Args:
        landmarks: 2D facial landmarks from MediaPipe
        image_size: Tuple of (height, width) of the image
        
    Returns:
        pitch, yaw, roll angles in degrees, rotation_vector, translation_vector, camera_matrix, dist_coeffs
    """
    # Scale factor based on user's face width
    scale_factor = USER_FACE_WIDTH / 150.0
    
    # 3D model points (generic face model)
    model_points = np.array([
        (0.0, 0.0, 0.0),                                          # Nose tip
        (0.0, -330.0 * scale_factor, -65.0 * scale_factor),       # Chin
        (-225.0 * scale_factor, 170.0 * scale_factor, -135.0 * scale_factor),  # Left eye left corner
        (225.0 * scale_factor, 170.0 * scale_factor, -135.0 * scale_factor),   # Right eye right corner
        (-150.0 * scale_factor, -150.0 * scale_factor, -125.0 * scale_factor), # Left mouth corner
        (150.0 * scale_factor, -150.0 * scale_factor, -125.0 * scale_factor)   # Right mouth corner
    ])
    
    # Camera internals
    focal_length = image_size[1]
    center = (image_size[1]/2, image_size[0]/2)
    camera_matrix = np.array([
        [focal_length, 0, center[0]],
        [0, focal_length, center[1]],
        [0, 0, 1]
    ], dtype="double")
    
    # Assuming no lens distortion
    dist_coeffs = np.zeros((4,1))
    
    # 2D image points from landmarks
    image_points = np.array([
        landmarks[NOSE_TIP_INDEX],
        landmarks[CHIN_INDEX],
        landmarks[LEFT_EYE_LEFT_CORNER_INDEX],
        landmarks[RIGHT_EYE_RIGHT_CORNER_INDEX],
        landmarks[LEFT_MOUTH_CORNER_INDEX],
        landmarks[RIGHT_MOUTH_CORNER_INDEX]
    ], dtype="double")
    
    # Solve for pose
    success, rotation_vector, translation_vector = cv.solvePnP(
        model_points, image_points, camera_matrix, dist_coeffs, 
        flags=cv.SOLVEPNP_ITERATIVE
    )
    
    # Convert rotation vector to rotation matrix
    rotation_matrix, _ = cv.Rodrigues(rotation_vector)
    
    # Combine rotation matrix and translation vector
    projection_matrix = np.hstack((rotation_matrix, translation_vector.reshape(-1, 1)))
    
    # Decompose to extract Euler angles
    _, _, _, _, _, _, euler_angles = cv.decomposeProjectionMatrix(projection_matrix)
    pitch, yaw, roll = euler_angles.flatten()[:3]
    
    # Normalize pitch
    pitch = normalize_pitch(pitch)
    
    return pitch, yaw, roll, rotation_vector, translation_vector, camera_matrix, dist_coeffs

def normalize_pitch(pitch):
    """
    Normalize pitch angle to range [-90, 90].
    
    Args:
        pitch: Raw pitch angle in degrees
        
    Returns:
        Normalized pitch angle
    """
    # Map to range [-180, 180]
    if pitch > 180:
        pitch -= 360
    
    # Invert for intuitive up/down movement
    pitch = -pitch
    
    # Ensure within [-90, 90]
    if pitch < -90:
        pitch = -(180 + pitch)
    elif pitch > 90:
        pitch = 180 - pitch
    
    pitch = -pitch
    
    return pitch

#-----------------------------------------------------------------------------------------------------------------------------------
# MAIN PROGRAM
#-----------------------------------------------------------------------------------------------------------------------------------

# Command-line arguments
parser = argparse.ArgumentParser(description="Head Pose Tracking (Yaw/Pitch)")
parser.add_argument("-c", "--camSource", help="Camera source", default=str(DEFAULT_WEBCAM))
args = parser.parse_args()

# Initialize MediaPipe Face Mesh
if PRINT_DATA:
    print("Initializing MediaPipe Face Mesh...")
    print("Head pose estimation: ENABLED")

mp_face_mesh = mp.solutions.face_mesh.FaceMesh(
    max_num_faces=1,
    refine_landmarks=True,
    min_detection_confidence=MIN_DETECTION_CONFIDENCE,
    min_tracking_confidence=MIN_TRACKING_CONFIDENCE,
)

# Initialize camera
cam_source = int(args.camSource)
cap = cv.VideoCapture(cam_source)

# Prepare CSV logging
csv_data = []
if not os.path.exists(LOG_FOLDER):
    os.makedirs(LOG_FOLDER)

column_names = ["Timestamp (ms)", "Pitch", "Yaw", "Roll"]

# Main loop
try:
    angle_buffer = AngleBuffer(size=MOVING_AVERAGE_WINDOW)
    
    if PRINT_DATA:
        print("\nControls:")
        print("  'c' - Calibrate head pose")
        print("  'r' - Start/Stop recording")
        print("  'q' - Quit\n")
    
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        rgb_frame = cv.cvtColor(frame, cv.COLOR_BGR2RGB)
        img_h, img_w = frame.shape[:2]
        results = mp_face_mesh.process(rgb_frame)
        
        if results.multi_face_landmarks:
            # Extract 2D landmarks
            mesh_points = np.array([
                np.multiply([p.x, p.y], [img_w, img_h]).astype(int)
                for p in results.multi_face_landmarks[0].landmark
            ])
            
            # Estimate head pose
            pitch, yaw, roll, rot_vec, trans_vec, cam_matrix, dist_coeffs = estimate_head_pose(mesh_points, (img_h, img_w))
            angle_buffer.add([pitch, yaw, roll])
            pitch, yaw, roll = angle_buffer.get_average()
            
            # Calibration
            if initial_pitch is None:
                initial_pitch, initial_yaw, initial_roll = pitch, yaw, roll
                calibrated = True
                if PRINT_DATA:
                    print("Initial calibration complete.")
            
            # Adjust angles based on calibration
            if calibrated:
                pitch_adjusted = pitch - initial_pitch
                yaw_adjusted = yaw - initial_yaw
                roll_adjusted = roll - initial_roll
            else:
                pitch_adjusted = pitch
                yaw_adjusted = yaw
                roll_adjusted = roll
            
            # Determine head direction
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
            
            # Draw visual indicators (purple circles on eyes/iris and direction line)
            # Draw purple circles around irises
            (l_cx, l_cy), l_radius = cv.minEnclosingCircle(mesh_points[LEFT_EYE_IRIS])
            (r_cx, r_cy), r_radius = cv.minEnclosingCircle(mesh_points[RIGHT_EYE_IRIS])
            center_left = np.array([l_cx, l_cy], dtype=np.int32)
            center_right = np.array([r_cx, r_cy], dtype=np.int32)
            
            cv.circle(frame, center_left, int(l_radius), (255, 0, 255), 2, cv.LINE_AA)  # Purple/magenta
            cv.circle(frame, center_right, int(r_radius), (255, 0, 255), 2, cv.LINE_AA)  # Purple/magenta
            
            # Draw eye corners
            cv.circle(frame, mesh_points[LEFT_EYE_INNER_CORNER][0], 3, (255, 255, 255), -1, cv.LINE_AA)  # White
            cv.circle(frame, mesh_points[LEFT_EYE_OUTER_CORNER][0], 3, (0, 255, 255), -1, cv.LINE_AA)    # Cyan
            cv.circle(frame, mesh_points[RIGHT_EYE_INNER_CORNER][0], 3, (255, 255, 255), -1, cv.LINE_AA) # White
            cv.circle(frame, mesh_points[RIGHT_EYE_OUTER_CORNER][0], 3, (0, 255, 255), -1, cv.LINE_AA)   # Cyan
            
            # Draw purple direction line from nose (properly projected from 3D)
            nose_2D_point = mesh_points[NOSE_TIP_INDEX]
            # Create a 3D point extending straight out from nose in 3D space (400 units forward)
            nose_3D_direction = np.array([[0.0, 0.0, 400.0]], dtype=np.float64)
            # Project this 3D point to 2D using the rotation and translation vectors
            nose_end_point_2D, _ = cv.projectPoints(nose_3D_direction, rot_vec, trans_vec, cam_matrix, dist_coeffs)
            
            p1 = tuple(nose_2D_point.astype(int))
            p2 = tuple(nose_end_point_2D[0][0].astype(int))
            cv.line(frame, p1, p2, (255, 0, 255), 3)  # Purple/magenta line
            
            # Print data
            if PRINT_DATA:
                print(f"Pitch: {pitch_adjusted:6.2f}° | Yaw: {yaw_adjusted:6.2f}° | Roll: {roll_adjusted:6.2f}° | Direction: {direction}")
            
            # Display on screen
            if SHOW_ON_SCREEN_DATA:
                # Recording indicator
                if IS_RECORDING:
                    cv.circle(frame, (30, 30), 10, (0, 0, 255), -1)
                
                # Angles
                cv.putText(frame, f"Pitch: {int(pitch_adjusted)}", (30, 80), 
                          cv.FONT_HERSHEY_DUPLEX, 0.8, (0, 255, 0), 2, cv.LINE_AA)
                cv.putText(frame, f"Yaw: {int(yaw_adjusted)}", (30, 110), 
                          cv.FONT_HERSHEY_DUPLEX, 0.8, (0, 255, 0), 2, cv.LINE_AA)
                cv.putText(frame, f"Roll: {int(roll_adjusted)}", (30, 140), 
                          cv.FONT_HERSHEY_DUPLEX, 0.8, (0, 255, 0), 2, cv.LINE_AA)
                cv.putText(frame, f"Looking: {direction}", (30, 170), 
                          cv.FONT_HERSHEY_DUPLEX, 0.8, (0, 255, 0), 2, cv.LINE_AA)
            
            # Log data
            if LOG_DATA and IS_RECORDING:
                timestamp = int(time.time() * 1000)
                log_entry = [timestamp, pitch_adjusted, yaw_adjusted, roll_adjusted]
                csv_data.append(log_entry)
        
        # Display frame
        cv.imshow("Head Pose Tracking", frame)
        
        # Handle key presses
        key = cv.waitKey(1) & 0xFF
        
        # Calibrate on 'c'
        if key == ord('c'):
            initial_pitch, initial_yaw, initial_roll = pitch, yaw, roll
            if PRINT_DATA:
                print("\n*** Head pose recalibrated. ***\n")
        
        # Toggle recording on 'r'
        if key == ord('r'):
            IS_RECORDING = not IS_RECORDING
            status = "started" if IS_RECORDING else "paused"
            print(f"\n*** Recording {status}. ***\n")
        
        # Exit on 'q'
        if key == ord('q'):
            if PRINT_DATA:
                print("\nExiting...")
            break

except Exception as e:
    print(f"Error occurred: {e}")
    import traceback
    traceback.print_exc()

finally:
    # Cleanup
    cap.release()
    cv.destroyAllWindows()
    
    if PRINT_DATA:
        print("Camera and windows closed.")
    
    # Save CSV file
    if LOG_DATA and IS_RECORDING and csv_data:
        timestamp_str = datetime.now().strftime("%Y%m%d_%H%M%S")
        csv_file_name = os.path.join(LOG_FOLDER, f"head_pose_log_{timestamp_str}.csv")
        
        with open(csv_file_name, "w", newline="") as file:
            writer = csv.writer(file)
            writer.writerow(column_names)
            writer.writerows(csv_data)
        
        if PRINT_DATA:
            print(f"Data saved to: {csv_file_name}")
    
    if PRINT_DATA:
        print("Program exited successfully.")
