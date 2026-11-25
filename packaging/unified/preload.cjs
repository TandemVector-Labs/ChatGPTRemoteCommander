'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('commander',Object.freeze({
  status:()=>ipcRenderer.invoke('commander:status'),
  preflight:()=>ipcRenderer.invoke('commander:migration:preflight'),
  startPreview:()=>ipcRenderer.invoke('commander:preview:start'),
  stopPreview:()=>ipcRenderer.invoke('commander:preview:stop')
}));
