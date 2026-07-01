@echo off
setlocal
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  where py >nul 2>nul
  if errorlevel 1 (
    echo Python not found. Trying to install Python with winget...
    winget install -e --id Python.Python.3.12
  )
)

where python >nul 2>nul
if errorlevel 1 (
  set PY=py -3
) else (
  set PY=python
)

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo ffmpeg not found. Trying to install ffmpeg with winget...
  winget install -e --id Gyan.FFmpeg
)

if not exist .venv (
  %PY% -m venv .venv
)
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python app.py
pause
