@echo off
setlocal
set "SRC=%~dp0"
set "DST=C:\Users\luvshade\Desktop\koilof"

echo Installing Koilof editor update...
if not exist "%DST%" mkdir "%DST%"
if not exist "%DST%\output" mkdir "%DST%\output"
if not exist "%DST%\uploads" mkdir "%DST%\uploads"
if not exist "%DST%\jobs" mkdir "%DST%\jobs"

copy /Y "%SRC%app.py" "%DST%\app.py" >nul
copy /Y "%SRC%desktop_app.py" "%DST%\desktop_app.py" >nul
copy /Y "%SRC%requirements.txt" "%DST%\requirements.txt" >nul
copy /Y "%SRC%README_RU.md" "%DST%\README_RU.md" >nul
copy /Y "%SRC%START_WINDOWS.cmd" "%DST%\START_WINDOWS.cmd" >nul
copy /Y "%SRC%START_DESKTOP.cmd" "%DST%\START_DESKTOP.cmd" >nul
copy /Y "%SRC%BUILD_EXE_WINDOWS.cmd" "%DST%\BUILD_EXE_WINDOWS.cmd" >nul
copy /Y "%SRC%design-qa.md" "%DST%\design-qa.md" >nul

robocopy "%SRC%web" "%DST%\web" /E /NFL /NDL /NJH /NJS /NP >nul
robocopy "%SRC%assets" "%DST%\assets" /E /NFL /NDL /NJH /NJS /NP >nul

echo.
echo Done. Run:
echo %DST%\START_DESKTOP.cmd
echo.
pause
