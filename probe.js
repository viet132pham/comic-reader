// Loaded inside the PiP window so the reader can learn that window's tab id from `sender.tab`.
chrome.runtime.sendMessage({ type: 'probe' }).catch(() => {});
