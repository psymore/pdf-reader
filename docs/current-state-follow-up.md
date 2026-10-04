# PDF Reader — Current State

## Completed

- Added distinct vertical-scroll and side-by-side layout icons.
- Fixed layout selection colors and state handling.
- Mobile defaults to vertical free-swiping mode.
- Replaced the mobile title with a view-options menu.
- Added sidebar actions to copy filenames, pin files, and remove entries from the reader list.
- Kept the original PDF safe when removing a sidebar entry.

## Verification

- Frontend: 24 tests passed.
- Tauri/Rust: 12 tests passed.
- JavaScript syntax and Git whitespace checks passed.

## Remaining Check

Test the updated toolbar, gestures, layouts, and sidebar actions on a physical Android device. No device was connected during the latest verification. Use `npx tauri android dev --host` after the phone appears in `adb devices`.
