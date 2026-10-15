// Toolbar click: float the reader over the current page. Pages that refuse scripts
// (chrome://, the Web Store, the new-tab page) get the reader in its own tab instead.
async function toggleOverlay(tab) {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['overlay.js'] });
  } catch {
    chrome.tabs.create({ url: 'reader.html' });
  }
}
chrome.action.onClicked.addListener(toggleOverlay);

// Session rules belong to a tab (see applyRules() in reader.js); drop them when the reader goes away.
async function dropRules(tabId) {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const ids = rules.filter(r => r.condition.tabIds?.includes(tabId)).map(r => r.id);
  if (ids.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
}
chrome.tabs.onRemoved.addListener(dropRules);
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'overlay-closed' && sender.tab) dropRules(sender.tab.id);
});
