# learn-with-subtitles

A Chrome extension that helps you learn a language by watching YouTube.

## What it does

- Shows the subtitles of a video in a big, clear box on the video.
- Shows all the subtitles in a list on the side. You can move this list.
- Can also show English subtitles under the main ones.
- Put your mouse on a word: the video stops and you see what the word means in English.
- Finds sayings and slang (like "nur Bahnhof verstehen") and marks them in orange.
- Lets you save words and sayings to learn later.
- Remembers which parts of which videos you watched, and in which language.
  This stays on your computer. You can download it as a file.
- Has an on/off switch.

## How to install

1. Download this project.
2. Open `chrome://extensions` in Chrome.
3. Turn on "Developer mode".
4. Click "Load unpacked" and pick this folder.
5. Open a YouTube video that has subtitles.

## Keys

| Key | What it does |
|---|---|
| A | Go back one line |
| S | Play this line again |
| D | Go to next line |
| Q | Stop after each line (on/off) |

## Where the words come from

Word meanings and the list of sayings come from
[Wiktionary](https://en.wiktionary.org/). The file `lists/de.json` is built
from Wiktionary categories and is shared under the
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) license.
