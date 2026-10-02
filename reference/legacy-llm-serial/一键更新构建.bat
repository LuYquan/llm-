@echo off
chcp 65001 >nul
title LLM串口 - 一键编译与同步更新
echo ========================================================
echo       正在全量编译最新前端与后端并同步更新到固定目录...
echo ========================================================
echo.

cd /d "%~dp0"
call npm run release

if %ERRORLEVEL% equ 0 (
    echo.
    echo ========================================================
    echo ✅ 构建与同步成功！最新软件已写入固定目录:
    echo    %~dp0release\LLM串口.exe
    echo ========================================================
    echo.
    set /p launch="是否立即启动最新版程序？(Y/n): "
    if /i "%launch%"=="n" (
        exit /b 0
    ) else (
        if exist "release\llm-serial.exe" (
            start "" "release\llm-serial.exe"
        ) else (
            start "" "release\LLM串口.exe"
        )
        exit /b 0
    )
) else (
    echo.
    echo ❌ 构建失败，请检查报错日志。
    pause
    exit /b 1
)
