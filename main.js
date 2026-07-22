const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

// 先启动后端服务器
require('./server.js');

const PORT = 3456;

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'AgentHub',
    icon: path.join(__dirname, 'agenthub.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // 等服务器启动后加载页面
  setTimeout(() => {
    win.loadURL(`http://localhost:${PORT}`);
  }, 500);

  // 外部链接用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
