"use strict";
// The only bridge between the window and the launcher. The window gets a few named actions, never
// direct access to files, the network or Node.
const { contextBridge, ipcRenderer } = require("electron");

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("marec", {
  state: () => call("state:get"),
  login: (email, password) => call("auth:login", email, password),
  logout: () => call("auth:logout"),
  library: () => call("library:list"),
  install: (gameId) => call("game:install", gameId),
  cancel: (gameId) => call("game:cancel", gameId),
  play: (gameId) => call("game:play", gameId),
  verify: (gameId) => call("game:verify", gameId),
  uninstall: (gameId) => call("game:uninstall", gameId),
  register: (email, password, displayName) => call("auth:register", email, password, displayName),
  categories: () => call("catalog:categories"),
  games: (query) => call("catalog:games", query),
  game: (slug) => call("catalog:game", slug),
  addToLibrary: (gameId) => call("library:add", gameId),
  studios: () => call("developer:studios"),
  createStudio: (name) => call("developer:createStudio", name),
  studioGames: (studioId) => call("developer:games", studioId),
  saveSettings: (settings) => call("settings:save", settings),
  pickFolder: () => call("settings:pickFolder"),
  onInstallProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("install:progress", listener);
    return () => ipcRenderer.removeListener("install:progress", listener);
  },
});
