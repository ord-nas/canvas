from flask import Flask
app = Flask(__name__,
            static_url_path='/static/',
            static_folder='static')

@app.route('/')
def hello_world():
    return 'Hello, World! This is a test! How is it going?'

