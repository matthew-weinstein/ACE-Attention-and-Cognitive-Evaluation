import cv2 as cv
import numpy as np
import mediapipe as mp
import argparse
import time
import csv
from datetime import datetime
import os
from AngleBuffer import AngleBuffer

USER_FACE_WIDTH = 140

PRINT_DATA = True
DEFAULT_WEBCAM = 0
SHOW_ON_SCREEN_DATA = True
LOG_DATA = True
LOG_FOLDER = "logs"
IS_RECORDING = False

MIN_DETECTION_CONFIDENCE = 0.8
MIN_TRACKING_CONFIDENCE = 0.8

MOVING_AVERAGE_WINDOW = 10

NOSE_TIP_INDEX = 4
CHIN_INDEX = 152
LEFT_EYE_LEFT_CORNER_INDEX = 33
RIGHT_EYE_RIGHT_CORNER_INDEX = 263
LEFT_MOUTH_CORNER_INDEX = 61
RIGHT_MOUTH_CORNER_INDEX = 291

LEFT_EYE_IRIS = [474, 475, 476, 477]
RIGHT_EYE_IRIS = [469, 470, 471, 472]
LEFT_EYE_OUTER_CORNER = [33]
LEFT_EYE_INNER_CORNER = [133]
RIGHT_EYE_OUTER_CORNER = [362]
RIGHT_EYE_INNER_CORNER = [263]

initial_pitch, initial_yaw, initial_roll = None, None, None
calibrated = False

def estimate_head_pose(landmarks, image_size):
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
    pitch = normalize_pitch(pitch)
    
    return pitch, yaw, roll, rotation_vector, translation_vector, camera_matrix, dist_coeffs

def normalize_pitch(pitch):
    if pitch > 180:
        pitch -= 360
    
    pitch = -pitch
    
    if pitch < -90:
        pitch = -(180 + pitch)
    elif pitch > 90:
        pitch = 180 - pitch
    
    pitch = -pitch
    
    return pitch

parser = argparse.ArgumentParser(description="Head Pose Tracking (Yaw/Pitch)")
parser.add_argument("-c", "--camSource", help="Camera source", default=str(DEFAULT_WEBCAM))
args = parser.parse_args()

if PRINT_DATA:
    print("Initializing MediaPipe Face Mesh...")
    print("Head pose estimation: ENABLED")

mp_face_mesh = mp.solutions.face_mesh.FaceMesh(
    max_num_faces=1,
    refine_landmarks=True,
    min_detection_confidence=MIN_DETECTION_CONFIDENCE,
    min_tracking_confidence=MIN_TRACKING_CONFIDENCE,
)

cam_source = int(args.camSource)
cap = cv.VideoCapture(cam_source)

csv_data = []
if not os.path.exists(LOG_FOLDER):
    os.makedirs(LOG_FOLDER)

column_names = ["Timestamp (ms)", "Pitch", "Yaw", "Roll"]

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
            mesh_points = np.array([
                np.multiply([p.x, p.y], [img_w, img_h]).astype(int)
                for p in results.multi_face_landmarks[0].landmark
            ])
            
            pitch, yaw, roll, rot_vec, trans_vec, cam_matrix, dist_coeffs = estimate_head_pose(mesh_points, (img_h, img_w))
            angle_buffer.add([pitch, yaw, roll])
            pitch, yaw, roll = angle_buffer.get_average()
            
            if initial_pitch is None:
                initial_pitch, initial_yaw, initial_roll = pitch, yaw, roll
                calibrated = True
                if PRINT_DATA:
                    print("Initial calibration complete.")
            
            if calibrated:
                pitch_adjusted = pitch - initial_pitch
                yaw_adjusted = yaw - initial_yaw
                roll_adjusted = roll - initial_roll
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
            
            (l_cx, l_cy), l_radius = cv.minEnclosingCircle(mesh_points[LEFT_EYE_IRIS])
            (r_cx, r_cy), r_radius = cv.minEnclosingCircle(mesh_points[RIGHT_EYE_IRIS])
            center_left = np.array([l_cx, l_cy], dtype=np.int32)
            center_right = np.array([r_cx, r_cy], dtype=np.int32)
            
            cv.circle(frame, center_left, int(l_radius), (255, 0, 255), 2, cv.LINE_AA)
            cv.circle(frame, center_right, int(r_radius), (255, 0, 255), 2, cv.LINE_AA)
            
            cv.circle(frame, mesh_points[LEFT_EYE_INNER_CORNER][0], 3, (255, 255, 255), -1, cv.LINE_AA)
            cv.circle(frame, mesh_points[LEFT_EYE_OUTER_CORNER][0], 3, (0, 255, 255), -1, cv.LINE_AA)
            cv.circle(frame, mesh_points[RIGHT_EYE_INNER_CORNER][0], 3, (255, 255, 255), -1, cv.LINE_AA)
            cv.circle(frame, mesh_points[RIGHT_EYE_OUTER_CORNER][0], 3, (0, 255, 255), -1, cv.LINE_AA)
            
            nose_2D_point = mesh_points[NOSE_TIP_INDEX]
            nose_3D_direction = np.array([[0.0, 0.0, 400.0]], dtype=np.float64)
            nose_end_point_2D, _ = cv.projectPoints(nose_3D_direction, rot_vec, trans_vec, cam_matrix, dist_coeffs)
            
            p1 = tuple(nose_2D_point.astype(int))
            p2 = tuple(nose_end_point_2D[0][0].astype(int))
            cv.line(frame, p1, p2, (255, 0, 255), 3)
            
            if PRINT_DATA:
                print(f"Pitch: {pitch_adjusted:6.2f}° | Yaw: {yaw_adjusted:6.2f}° | Roll: {roll_adjusted:6.2f}° | Direction: {direction}")
            
            if SHOW_ON_SCREEN_DATA:
                if IS_RECORDING:
                    cv.circle(frame, (30, 30), 10, (0, 0, 255), -1)
                
                cv.putText(frame, f"Pitch: {int(pitch_adjusted)}", (30, 80), 
                          cv.FONT_HERSHEY_DUPLEX, 0.8, (0, 255, 0), 2, cv.LINE_AA)
                cv.putText(frame, f"Yaw: {int(yaw_adjusted)}", (30, 110), 
                          cv.FONT_HERSHEY_DUPLEX, 0.8, (0, 255, 0), 2, cv.LINE_AA)
                cv.putText(frame, f"Roll: {int(roll_adjusted)}", (30, 140), 
                          cv.FONT_HERSHEY_DUPLEX, 0.8, (0, 255, 0), 2, cv.LINE_AA)
                cv.putText(frame, f"Looking: {direction}", (30, 170), 
                          cv.FONT_HERSHEY_DUPLEX, 0.8, (0, 255, 0), 2, cv.LINE_AA)
            
            if LOG_DATA and IS_RECORDING:
                timestamp = int(time.time() * 1000)
                log_entry = [timestamp, pitch_adjusted, yaw_adjusted, roll_adjusted]
                csv_data.append(log_entry)
        
        cv.imshow("Head Pose Tracking", frame)
        
        key = cv.waitKey(1) & 0xFF
        
        if key == ord('c'):
            initial_pitch, initial_yaw, initial_roll = pitch, yaw, roll
            if PRINT_DATA:
                print("\n*** Head pose recalibrated. ***\n")
        
        if key == ord('r'):
            IS_RECORDING = not IS_RECORDING
            status = "started" if IS_RECORDING else "paused"
            print(f"\n*** Recording {status}. ***\n")
        
        if key == ord('q'):
            if PRINT_DATA:
                print("\nExiting...")
            break

except Exception as e:
    print(f"Error occurred: {e}")
    import traceback
    traceback.print_exc()

finally:
    cap.release()
    cv.destroyAllWindows()
    
    if PRINT_DATA:
        print("Camera and windows closed.")
    
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
