import os
import base64
import cv2
import numpy as np
from flask import Flask, request
app = Flask(__name__,
            static_url_path='/static/',
            static_folder='static')

class ExportManager(object):
    def __init__(self, export_dir):
        self.export_dir = export_dir
        self.video_writer = None
    def avoid_filename_conflicts(self, initial_filename):
        (root, ext) = os.path.splitext(initial_filename)
        adjusted_root = root
        version = 0
        while os.path.exists(os.path.join(self.export_dir, adjusted_root + ext)):
            version += 1
            adjusted_root = root + " " + str(version)
        return adjusted_root + ext
    def start_export(self, filename, fps, frame_width, frame_height):
        filename = self.avoid_filename_conflicts(filename)
        try:
            if self.video_writer is not None:
                self.video_writer.release()
            path = os.path.join(self.export_dir, filename)
            self.video_writer = cv2.VideoWriter(
                path,
                cv2.VideoWriter_fourcc('M','P','E','G'),
                fps,
                (frame_width,frame_height))
            return True
        except:
            self.video_writer = None
            return False
    def write_frame(self, frame):
        try:
            self.video_writer.write(frame)
            return True
        except:
            return False
    def finish_export(self):
        try:
            self.video_writer.release()
            self.video_writer = None
            return True
        except:
            return False

# Global singleton
export_manager = ExportManager('/home/sandro/Documents/Canvas Exports/')

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
    except:
        return None

@app.route('/')
def hello_world():
    return 'Hello, World!'

@app.route('/start_export', methods=['POST'])
def start_export():
    global export_manager
    success = export_manager.start_export(request.form['filename'],
                                          int(request.form['fps']),
                                          int(request.form['frame_width']),
                                          int(request.form['frame_height']))
    error_code = 200 if success else 500
    return '', error_code

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
