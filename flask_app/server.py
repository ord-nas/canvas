import time
import os
import base64
import cv2
import numpy as np
import json
import re
import traceback
from flask import Flask, request
app = Flask(__name__,
            static_url_path='/static/',
            static_folder='static')
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0

# Global paths.
PROJECT_PATH = '/home/sandro/Documents/Canvas Projects/'
VIDEO_FILE_REGEX = r'.*\.avi$'
PROJECT_FILE_REGEX = r'.*\.cnvs$'

def filename_with_version(filename, version):
    m = re.match(r'^(.*) \(([1-9][0-9]*)\)$', filename)
    if not m:
        return "%s (%d)" % (filename, version)
    else:
        number = int(m.group(2))
        number += version
        return "%s (%d)" % (m.group(1), number)

def avoid_filename_conflicts(initial_filename):
    (root, ext) = os.path.splitext(initial_filename)
    adjusted_root = root
    version = 0
    while os.path.exists(adjusted_root + ext):
        version += 1
        adjusted_root = filename_with_version(root, version)
    return adjusted_root + ext

class ExportManager(object):
    def __init__(self, export_dir):
        self.export_dir = export_dir
        self.video_writer = None
    def start_export(self, filename, fps, frame_width, frame_height):
        if not re.match(VIDEO_FILE_REGEX, filename):
            # Default to .avi extension if filename is not a valid video file.
            filename = filename + ".avi"
        path = os.path.join(self.export_dir, filename)
        new_path = avoid_filename_conflicts(path)
        adjustment_performed = (new_path != path)
        path = new_path
        try:
            if self.video_writer is not None:
                self.video_writer.release()
            self.video_writer = cv2.VideoWriter(
                path,
                cv2.VideoWriter_fourcc('M','P','E','G'),
                fps,
                (frame_width,frame_height))
            return {
                "final_export_path" : os.path.relpath(path, PROJECT_PATH),
                "path_adjusted_to_avoid_overwrite" : adjustment_performed
            }
        except Exception as e:
            print("Exception", e)
            print(traceback.format_exc())
            self.video_writer = None
            return None
    def write_frame(self, frame):
        try:
            self.video_writer.write(frame)
            return True
        except Exception as e:
            print("Exception", e)
            print(traceback.format_exc())
            return False
    def finish_export(self):
        try:
            self.video_writer.release()
            self.video_writer = None
            return True
        except Exception as e:
            print("Exception", e)
            print(traceback.format_exc())
            return False

# Global singleton
export_manager = ExportManager(PROJECT_PATH)

def decode_frame(data_url):
    try:
        header = "data:image/png;base64,"
        if not data_url.startswith(header):
            return None
        encoded_data = data_url[len(header):]
        data = base64.b64decode(encoded_data)
        arr = np.fromstring(data, np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        return frame
    except Exception as e:
        print("Exception", e)
        print(traceback.format_exc())
        return None

@app.route('/')
def hello_world():
    return 'Hello, World!'

@app.route('/start_export', methods=['POST'])
def start_export():
    global export_manager
    outcome = export_manager.start_export(request.form['filename'],
                                          int(request.form['fps']),
                                          int(request.form['frame_width']),
                                          int(request.form['frame_height']))
    if outcome is None:
        return '', 500
    else:
        return json.dumps(outcome), 200

@app.route('/write_frame', methods=['POST'])
def write_frame():
    global export_manager

    frame = decode_frame(request.form['data_url'])
    if frame is None:
        return '', 500

    success = export_manager.write_frame(frame)
    error_code = 200 if success else 500
    return '', error_code

@app.route('/finish_export', methods=['POST'])
def finish_export():
    global export_manager

    success = export_manager.finish_export()
    error_code = 200 if success else 500
    return '', error_code

@app.route('/cancel_export', methods=['POST'])
# This is the same as finish for now.
def cancel_export():
    global export_manager

    success = export_manager.finish_export()
    error_code = 200 if success else 500
    return '', error_code

@app.route('/save_project', methods=['POST'])
def save_project():
    filename = request.form['project_filepath']
    data = request.form['project_data']
    overwrite = request.form['overwrite']

    # Construct the full path to write to.
    if not re.match(PROJECT_FILE_REGEX, filename):
        # Default to .cnvs extension if filename is not a valid project file.
        filename = filename + ".cnvs"
    path = os.path.join(PROJECT_PATH, filename)
    adjustment_performed = False
    if overwrite != "true":
        new_path = avoid_filename_conflicts(path)
        adjustment_performed = (new_path != path)
        path = new_path

    try:
        print("About to save to: " + path)
        with open(path, "w") as f:
            f.write(data)
    except Exception as e:
        print("Exception", e)
        print(traceback.format_exc())
        return '', 500

    return_payload = {
        "final_project_path" : os.path.relpath(path, PROJECT_PATH),
        "path_adjusted_to_avoid_overwrite" : adjustment_performed
    }

    return json.dumps(return_payload), 200

@app.route('/open_project', methods=['POST'])
def open_project():
    filename = request.form['project_filepath']

    # Construct the full path to read from.
    path = os.path.join(PROJECT_PATH, filename)

    try:
        print("About to open: " + path)
        with open(path, "r") as f:
            return f.read(), 200
    except Exception as e:
        print("Exception", e)
        print(traceback.format_exc())
        return '', 500

@app.route('/list_project_directory', methods=['GET'])
def list_project_directory():
    directory_info = {}
    for (root, dirs, files) in os.walk(PROJECT_PATH):
        relpath = os.path.relpath(root, PROJECT_PATH)
        if relpath == ".":
            relpath = ""
        directory_info[relpath] = {
            "files": sorted(files),
            "directories": sorted(dirs),
        }

    return_payload = {
        "project_directory_contents": directory_info,
        "video_file_regex": VIDEO_FILE_REGEX,
        "project_file_regex": PROJECT_FILE_REGEX,
    }

    return json.dumps(return_payload), 200
