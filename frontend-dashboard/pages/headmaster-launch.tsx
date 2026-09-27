// Headmaster launch staging page (runtime operations).
//
// Public, auth-free surface that exists so the embedding parent always has a
// bridge-bearing document to talk to, even before any Nora session exists
// (the authenticated pages bounce anonymous visitors to the marketing login,
// which is outside the bridge). On successful redemption the bridge navigates
// this window to the operator dashboard; when a valid session already exists
// it reports ready and the parent proceeds directly. Does nothing when this
// page is opened top-level or without the configured build-time parent origin.

import { useEffect } from "react";
import { startHeadmasterBridge } from "../lib/headmaster";

function HeadmasterLaunchPage() {
  useEffect(() => {
    return startHeadmasterBridge({
      view: "runtime-operations",
      entryPath: "/app/dashboard",
    });
  }, []);
  return null;
}

HeadmasterLaunchPage.isHeadmasterLaunchPage = true;

export default HeadmasterLaunchPage;
