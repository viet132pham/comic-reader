// The comic frame was sent to a shopping/affiliate page; rules/ads.json redirected it here.
// The reader decides where to go instead.
chrome.runtime.sendMessage({ type: 'bounced' }).catch(() => {});
