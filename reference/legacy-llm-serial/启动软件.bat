@echo off
chcp 65001 >nul
title 启动 LLM串口
cd /d "%~dp0"

if exist "%~dp0release\LLM串口.exe" (
    start "" "%~dp0release\LLM串口.exe"
) else if exist "%~dp0dist\portable\llm-serial-v0.1.0-portable\LLM串口.exe" (
    start "" "%~dp0dist\portable\llm-serial-v0.1.0-portable\LLM串口.exe"
) else (
    echo [提示] 尚未检测到已编译好的程序，正在执行初次编译构建...
    call npm run release
    if exist "%~dp0release\LLM串口.exe" (
        start "" "%~dp0release\LLM串口.exe"
    )
)
exit /b 0
