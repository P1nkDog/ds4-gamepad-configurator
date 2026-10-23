@echo off
rem ============================================================
rem  DS4 手柄配置器 - Windows 一键启动本地服务器
rem  依次尝试 python / py / npx，自动打开浏览器
rem  本文件为 GBK(936) 编码 + CRLF 换行，请勿另存为 UTF-8
rem ============================================================
setlocal
chcp 936 >nul 2>nul
cd /d "%~dp0"
set "PORT=8080"

echo.
echo   DS4 手柄配置器 - 本地服务器
echo   目录：%CD%
echo.

where python >nul 2>nul
if not errorlevel 1 goto use_python
where py >nul 2>nul
if not errorlevel 1 goto use_py
where npx >nul 2>nul
if not errorlevel 1 goto use_npx

echo   错误：未找到 python / py / npx，请先安装 Python 或 Node.js。
echo.
pause
exit /b 1

:use_python
set "PY=python"
goto serve

:use_py
set "PY=py"
goto serve

:use_npx
echo   启动方式：npx serve
echo   访问地址：http://localhost:%PORT%
echo   停止方式：按 Ctrl+C
echo.
start "" "http://localhost:%PORT%"
npx --yes serve -l %PORT%
goto done

:serve
echo   启动方式：%PY% -m http.server %PORT%
echo   访问地址：http://localhost:%PORT%
echo   停止方式：按 Ctrl+C
echo.
start "" "http://localhost:%PORT%"
%PY% -m http.server %PORT%

:done
echo.
echo   服务器已停止。
pause
