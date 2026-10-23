import os
import pickle
import sqlite3
import subprocess
from flask import Flask, request

app = Flask(__name__)

@app.post('/admin/run')
def run_command():
    return subprocess.check_output(request.json['command'], shell=True).decode()

@app.post('/admin/evaluate')
def evaluate():
    return str(eval(request.json['expression']))

@app.post('/admin/import')
def import_data():
    return str(pickle.loads(request.get_data()))

@app.get('/users')
def users():
    connection = sqlite3.connect('users.db')
    return str(connection.execute("SELECT * FROM users WHERE name = '" + request.args['name'] + "'").fetchall())

@app.get('/files')
def files():
    return open('/srv/uploads/' + request.args['path']).read()

@app.get('/erase')
def erase():
    os.remove(request.args['path'])
    return 'deleted'

@app.get('/fetch')
def fetch():
    import urllib.request
    return urllib.request.urlopen(request.args['url']).read()

if __name__ == '__main__':
    app.run(host='0.0.0.0', debug=True)
