// pdf.js loads its CMYK profile by a fixed file name with a synchronous request, the
// first time it meets plain CMYK colour. When a profile was chosen, answer that request
// with it instead.
//
// The profile arrives as a message ({bookviewProfile: blob URL or null}) that this
// listener sees before pdf.js does and keeps from it. That lets the document be opened
// before the profile is known (it depends on the file's output intent, read in parallel);
// the render worker sends it before asking for any page.

const BUILT_IN = "CGATS001Compat-v2-micro.icc";
let profile = null;

self.addEventListener("message", (/** @type {MessageEvent} */ event) => {
  if (event.data && typeof event.data === "object" && "bookviewProfile" in event.data) {
    profile = event.data.bookviewProfile;
    event.stopImmediatePropagation();
  }
});

const xhrOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (method, url, ...rest) {
  const redirected = profile && typeof url === "string" && url.endsWith(BUILT_IN) ? profile : url;
  return xhrOpen.call(this, method, redirected, ...rest);
};
