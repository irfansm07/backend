@echo off
echo ============================================
echo   VIBEXPERT - Deploy Hot Topics Feature
echo ============================================
echo.
echo This will:
echo 1. Stage all changes
echo 2. Commit with message
echo 3. Push to GitHub
echo 4. Trigger Render auto-deploy
echo.
pause

cd /d "%~dp0"

echo.
echo [1/3] Staging changes...
git add .

echo.
echo [2/3] Committing changes...
git commit -m "Add Hot Topics AI feature with Google Gemini API - Real news extraction from PDF"

echo.
echo [3/3] Pushing to GitHub...
git push origin main

echo.
echo ============================================
echo   SUCCESS! Deployment triggered!
echo ============================================
echo.
echo Render will auto-deploy in 2-3 minutes.
echo.
echo NEXT STEPS:
echo 1. Go to https://dashboard.render.com
echo 2. Add GEMINI_API_KEY environment variable
echo 3. Get API key from https://makersuite.google.com/app/apikey
echo.
pause
