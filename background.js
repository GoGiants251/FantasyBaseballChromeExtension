// background.js
// This service worker enables Chrome's native side panel for the extension.
// Clicking the extension icon opens Fantasy Baseball Helper without covering
// the fantasy baseball page itself.

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((error) => console.warn("Could not enable side panel behavior:", error));
  }
});

chrome.action.onClicked.addListener((tab) => {
  if (chrome.sidePanel?.open && tab.id) {
    chrome.sidePanel
      .open({ tabId: tab.id })
      .catch((error) => console.warn("Could not open side panel:", error));
  }
});
