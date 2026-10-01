@echo off
rem ==========================================================================
rem  Dominord - self-play training on an NVIDIA GPU (Windows)
rem
rem  Double-click, or from a terminal in this folder:
rem      train_gpu.bat                 24 hours, actors = logical CPUs - 2
rem      train_gpu.bat 8               8 hours
rem      train_gpu.bat 8 6             8 hours, 6 self-play processes
rem
rem  It checks Python, numpy, the NVIDIA driver and a CUDA build of PyTorch
rem  that really runs on your card (a GTX 10xx needs the CUDA 12.6 or 11.8
rem  wheels; newer wheels dropped it). If something is missing it offers to
rem  install it into a private .venv folder, leaving your own Python alone.
rem  Run it again any time: it resumes where the last run stopped.
rem ==========================================================================
setlocal EnableExtensions
title Dominord - GPU training
cd /d "%~dp0"
chcp 65001 >nul
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"

set "HOURS=%~1"
if "%HOURS%"=="" set "HOURS=24"
set "ACTORS=%~2"
if "%ACTORS%"=="" set /a ACTORS=%NUMBER_OF_PROCESSORS%-2
if %ACTORS% LSS 1 set "ACTORS=1"
set "RUN=runs\gpu"
set "INIT=checkpoints\cpu2.pt"
set "TORCH_PRIMARY=https://download.pytorch.org/whl/cu126"
set "TORCH_FALLBACK=https://download.pytorch.org/whl/cu118"
set "TRIED="
set "NUMPY_TRIED="
set "ASKED="

echo.
echo  Dominord GPU training
echo  ---------------------
if not exist "dominord\train\train.py" (
    echo  This file must stay in the root of the dominord repository.
    goto :fail
)

rem ---------------------------------------------------------------- driver
echo.
echo  [1/3] NVIDIA driver
where nvidia-smi >nul 2>nul
if errorlevel 1 goto :nodriver
nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
goto :findpython
:nodriver
echo  nvidia-smi was not found. Install the latest GeForce driver from
echo  https://www.nvidia.com/Download/index.aspx and run this again.
goto :fail

rem ---------------------------------------------------------------- python
:findpython
echo.
echo  [2/3] Python
set "PY="
if exist ".venv\Scripts\python.exe" set "PY=.venv\Scripts\python.exe"
if defined PY goto :check
py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
if not errorlevel 1 set "PY=py -3"
if defined PY goto :check
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
if not errorlevel 1 set "PY=python"
if defined PY goto :check
echo  No Python 3.10 or newer found. Install Python 3.12 from
echo  https://www.python.org/downloads/ and tick "Add python.exe to PATH".
goto :fail

:check
%PY% scripts\check_train_env.py
set "RC=%errorlevel%"
if "%RC%"=="0" goto :train
if "%RC%"=="10" goto :numpy
if "%RC%"=="30" goto :oldpython
goto :torch

:numpy
if defined NUMPY_TRIED goto :fail
set "NUMPY_TRIED=1"
echo  Installing numpy...
%PY% -m pip install numpy
goto :check

:oldpython
echo  Install Python 3.12 from https://www.python.org/downloads/ and run this again.
goto :fail

rem ---------------------------------------------------------------- torch
:torch
if "%TRIED%"=="fallback" goto :torchfail
if defined ASKED goto :venv
set "ASKED=1"
echo.
echo  PyTorch with CUDA support for your GPU is needed.
echo  It will be installed into .venv in this folder, about 3 GB to download.
echo  Your own Python installation is not touched.
choice /c YN /m "  Install it now"
if errorlevel 2 goto :fail
:venv
if exist ".venv\Scripts\python.exe" goto :venvready
echo  Creating .venv ...
%PY% -m venv .venv
if errorlevel 1 goto :fail
:venvready
set "PY=.venv\Scripts\python.exe"
%PY% -m pip install --upgrade pip >nul
if "%TRIED%"=="primary" goto :usefallback
set "TRIED=primary"
set "IDX=%TORCH_PRIMARY%"
goto :installtorch
:usefallback
set "TRIED=fallback"
set "IDX=%TORCH_FALLBACK%"
echo  That build cannot run on this card; trying the CUDA 11.8 build.
:installtorch
%PY% -m pip uninstall -y torch >nul 2>nul
echo  Installing PyTorch from %IDX% ...
%PY% -m pip install torch --index-url %IDX%
%PY% -m pip install numpy
goto :check

:torchfail
echo.
echo  Neither CUDA build of PyTorch runs on this GPU. Update the NVIDIA driver,
echo  then delete the .venv folder and run this again. If it still fails,
echo  install Python 3.12, since older CUDA builds lag behind new Pythons.
goto :fail

rem ---------------------------------------------------------------- train
:train
echo.
echo  [3/3] Training for %HOURS% hours with %ACTORS% self-play processes
if exist "%RUN%\current.pt" echo  Resuming the run in %RUN%
if not exist "%RUN%\current.pt" echo  New run in %RUN%, warm-started from %INIT%
echo.
echo  - Progress is printed every 30 s: "hands" is the running total and
echo    decisions_per_s the speed, about 14 per hand.
echo  - A line containing "promoted" means a new champion: it is exported to
echo    web\models\dominord-net.json automatically.
echo  - Stop early with Ctrl+C, wait for the final evaluation, and answer N to
echo    "Terminate batch job?" so the page is rebuilt.
echo  - Set Windows sleep to Never while it runs; a sleeping PC pauses training.
echo.
%PY% -m dominord.train --out %RUN% --device cuda --hours %HOURS% --actors %ACTORS% --eval-min 30 --resume --init %INIT% --export web\models\dominord-net.json
echo.
echo  Rebuilding the page with the current champion ...
%PY% scripts\build_web.py
if errorlevel 1 goto :fail
echo.
echo  Done. Open dist\dominord-mesa.html in a browser, or copy it to your phone.
echo  Run this file again to keep training from where it stopped.
start "" "dist\dominord-mesa.html"
pause
exit /b 0

:fail
echo.
echo  Stopped. Fix the issue above and run train_gpu.bat again.
pause
exit /b 1
