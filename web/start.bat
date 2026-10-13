@echo off
cd /d "%~dp0"
start chrome http://localhost:8080
python serve.py 8080
pause
