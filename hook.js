// Page-world half of content.js. Only active inside the reader's comic frame (content.js marks
// <html> first): a blocked popup's URL is handed to the reader instead of silently vanishing,
// so "open the real chapter in a new tab, send this page to Shopee" can land on the chapter.
if (document.documentElement?.hasAttribute('data-comic-reader')) {
  window.open = function (url) {
    document.dispatchEvent(new CustomEvent('comic-reader-open', { detail: String(url ?? '') }));
    return null;
  };
}
