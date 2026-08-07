const USER_ORIGINS = new Set(["user_ui", "user_tool"]);

function isUserOrigin(origin) {
  return typeof origin === "string" && USER_ORIGINS.has(origin);
}

function decideTitleWrite(previous, origin) {
  const incomingIsUser = isUserOrigin(origin);
  const prevLocked = !!(previous && previous.userSet === true);
  if (!incomingIsUser && prevLocked) {
    return { allowed: false, code: "session_user_locked" };
  }
  const nextUserSet = incomingIsUser || prevLocked;
  return { allowed: true, nextUserSet };
}

module.exports = { decideTitleWrite, isUserOrigin };
