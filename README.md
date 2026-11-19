# learn-with-subtitles

A Chrome extension that turns YouTube into a language-learning environment.
It replaces the native captions with an interactive subtitle layer, explains
words and expressions in context, and records the language input each viewer
is exposed to.

## Features

**Interactive subtitles**
- Clear, readable subtitle overlay on the video, with optional English
  subtitles shown underneath.
- Movable side panel with the full transcript, synced to playback.
- Keyboard controls for replaying, skipping and pausing line by line.

**In-context dictionary**
- Hover over any word to pause the video and see its English definition.
- Automatic detection of idioms, fixed expressions and slang
  (e.g. *nur Bahnhof verstehen*), highlighted directly in the subtitles.
- Save words and expressions to a personal list for later review.

**Input tracking**
- Records which parts of each video were watched, tagged by spoken language.
- All data is stored locally in the browser and can be exported as JSONL
  for analysis.

**Control**
- One-click on/off switch, plus separate toggles for the overlay, side panel,
  English subtitles and hover dictionary.

## Installation

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the repository folder.
5. Open any YouTube video with subtitles.

## Keyboard shortcuts

| Key | Action |
|---|---|
| A | Previous line |
| S | Replay current line |
| D | Next line |
| Q | Toggle auto-pause after each line |

## Data sources

Definitions and the expression list are sourced from
[Wiktionary](https://en.wiktionary.org/). `lists/de.json` is derived from
Wiktionary categories and is licensed under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
