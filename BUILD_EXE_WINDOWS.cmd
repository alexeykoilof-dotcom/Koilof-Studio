@echo off
setlocal
cd /d "%~dp0"
call .venv\Scripts\activate.bat
python -m pip install pyinstaller
pyinstaller --onefile --name LyricsVideoStudioPro --add-data "web;web" app.py
pause
