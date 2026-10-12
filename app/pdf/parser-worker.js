// pdf.js's parsing worker, with one change: plain CMYK (DeviceCMYK) is converted through
// the profile we choose (the PDF's output intent, or one picked in the Colour settings)
// instead of pdf.js's built-in US profile. See parser-profile.js.
//
// Static imports run in order: the profile hook is installed before pdf.js starts, and
// pdf.js starts listening synchronously, so no early message is lost.

import "./parser-profile.js";
import "../../vendor/pdf.worker.mjs";
