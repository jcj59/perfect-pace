# Real phone checklist

Automated tests emulate phones in Chromium. Before calling the MVP done (PR 14), check these on a
real iPhone (Safari) and a real Android phone (Chrome), on the production URL. Note the device, OS
and browser version for each run.

## Layout and touch

- [ ] Portrait: the sheet's header (name, GPX and Draw buttons) sits fully above the home indicator
      at peek; nothing hides under the status bar or notch at full height.
- [ ] Landscape: the side panel and map controls clear the notch and rounded corners.
- [ ] Drag the sheet between peek, half and full, and fling it; it never scrolls the page behind it.
- [ ] No horizontal scrolling anywhere, and pinch zoom works on the map only.
- [ ] Every button is easy to hit with a thumb; the drawing handles can be dragged without zooming.

## Courses and plans

- [ ] Load a GPX file from Files (iOS) or Downloads (Android); the course, chart and plan appear.
- [ ] Draw a route with taps; drag a point; undo and redo.
- [ ] Scrub the elevation chart with a finger; the map marker follows.
- [ ] Copy a share link, open it in another browser; the same plan appears.
- [ ] Export GPX and CSV, and print (or save as PDF) the pace band.

## Install and offline

- [ ] Install: iOS Share > Add to Home Screen; Android Chrome menu > Install app. The icon looks
      right (not cropped, no white border) and the app opens full screen with no browser bar.
- [ ] In the installed app, load a GPX course and wait for its plan. Turn on airplane mode, close
      the app fully and reopen it: the course and plan come back, the status line says "Offline",
      and Draw is off with a note saying it needs a connection.
- [ ] Still offline, load a second GPX file that has elevation; it plans normally.
- [ ] Turn airplane mode off: "Offline" goes away and Draw works again.
- [ ] After a new deploy, with the app open, "A new version is ready" with Reload appears (it may
      take a reopen); Reload shows the new build and keeps the course.

## Themes and accessibility

- [ ] Light and dark (follow the system, then pick each in Appearance): text is readable and the
      status bar color matches the app.
- [ ] VoiceOver (iOS) or TalkBack (Android): the panel, sheet handle, chart and plan read sensibly.
- [ ] With Reduce Motion on, the sheet and map move without animation.
