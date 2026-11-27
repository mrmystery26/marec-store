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
  providers: () => call("auth:providers"),
  googleSignIn: () => call("auth:googleStart"),
  googleCancel: () => call("auth:googleCancel"),
  sendEmailCode: () => call("auth:sendEmailCode"),
  verifyEmail: (code) => call("auth:verifyEmail", code),
  developerAccount: () => call("developer:account"),
  registerDeveloper: (studioName, termsVersion) => call("developer:register", studioName, termsVersion),
  studioGames: (studioId) => call("developer:games", studioId),
  createGame: (studioId, title) => call("developer:createGame", studioId, title),
  developerGame: (gameId) => call("developer:game", gameId),
  updateGame: (gameId, changes) => call("developer:updateGame", gameId, changes),
  submitGame: (gameId) => call("developer:submitGame", gameId),
  builds: (gameId) => call("developer:builds", gameId),
  pickBuildFolder: () => call("developer:pickBuildFolder"),
  uploadBuild: (options) => call("developer:uploadBuild", options),
  cancelUpload: () => call("developer:cancelUpload"),
  downloadSdkConfig: (gameId) => call("developer:downloadSdkConfig", gameId),
  adminStudios: (status) => call("admin:studios", status),
  verifyStudio: (studioId) => call("admin:verifyStudio", studioId),
  adminGames: (status) => call("admin:games", status),
  transitionGame: (gameId, action, reason) => call("admin:transition", gameId, action, reason),
  friends: () => call("friends:list"),
  friendRequests: () => call("friends:requests"),
  friendCode: () => call("friends:code"),
  resetFriendCode: () => call("friends:resetCode"),
  sendFriendRequest: (code) => call("friends:send", code),
  acceptFriendRequest: (requestId) => call("friends:accept", requestId),
  declineFriendRequest: (requestId) => call("friends:decline", requestId),
  cancelFriendRequest: (requestId) => call("friends:cancel", requestId),
  removeFriend: (userId) => call("friends:remove", userId),
  saveSettings: (settings) => call("settings:save", settings),
  pickFolder: () => call("settings:pickFolder"),
  onAuthEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("auth:event", listener);
    return () => ipcRenderer.removeListener("auth:event", listener);
  },
  onUploadProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("upload:progress", listener);
    return () => ipcRenderer.removeListener("upload:progress", listener);
  },
  onInstallProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("install:progress", listener);
    return () => ipcRenderer.removeListener("install:progress", listener);
  },
});
