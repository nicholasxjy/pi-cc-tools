# pi-claude-code-ui

[![npm](https://img.shields.io/npm/v/pi-claude-code-ui?color=cb6d3d&label=npm)](https://www.npmjs.com/package/pi-claude-code-ui)
[![license](https://img.shields.io/npm/l/pi-claude-code-ui?color=8a8a8a)](https://www.npmjs.com/package/pi-claude-code-ui)

A Claude Code style interface for [pi](https://github.com/earendil-works/pi). Tool calls fold into one-line summaries, every edit shows a syntax-highlighted diff, the spinner says what pi is doing, and the colors come from your terminal theme.

![pi with pi-claude-code-ui fixing a failing test](https://raw.githubusercontent.com/FammasMaz/pi-cc-tools/master/docs/media/demo.gif)

```bash
pi install npm:pi-claude-code-ui
```

Terminal colors need pi 1.4 or newer. The package was called `pi-claude-style-tools` before 1.0.69.

## Tool calls

Consecutive tool calls collapse into one sentence, such as `Read 2 files, ran 1 shell command`. While they run, the row reads `Reading 2 files, running 1 shell command… · 3s` and shows the call in progress below it. A failed call turns the dot red and adds `· 1 failed`.

Click a row (in pi's fullscreen mode) or press `Ctrl+O` to see every call and its output. `Ctrl+Shift+O` raises the preview limits for long outputs. A row stays where you clicked it, and the view scrolls only as far as needed to show what opened.

![Clicking a grouped row and a thinking row to expand them](https://raw.githubusercontent.com/FammasMaz/pi-cc-tools/master/docs/media/click-to-expand.gif)

Built-in tools (`read`, `bash`, `grep`, `find`, `ls`, `edit`, `write`), MCP tools, OpenAI-style tools such as `apply_patch`, `webfetch` and `web_search`, and any custom tool all use the same row layout.

## Diffs

`edit` and `write` show the change as a diff with syntax highlighting and word-level marks. Several edits to one file are listed one after the other. On wide terminals the diff can also use a side-by-side layout.

While `edit`, `write` and `apply_patch` arguments stream in, **Progressive output** shows the latest text immediately, with added and removed text in diff colors. For edits, it follows the latest edit block as its original and replacement text arrive. The preview uses `diffCollapsedLines` (up to 150 lines when expanded) and a 32,000-character window; long lines are clipped to the row width. It reuses unchanged visible text and defers line comparison, word marks and syntax highlighting until the arguments are complete (or the write finishes).

![A two-part edit shown as a diff](https://raw.githubusercontent.com/FammasMaz/pi-cc-tools/master/docs/media/edit-diff.png)

Shell commands that only change files are drawn the same way. `sed -i`, `perl -pi`, heredocs (`cat > file <<EOF`, `tee`) and `echo … > file` show up as `Edit (sed) pyproject.toml` or `Create (heredoc) CHANGELOG.md`, with a diff of what actually changed on disk. The command runs unchanged and the model sees its normal output. Anything ambiguous, like a pipe or a variable, stays a regular bash row.

![sed and heredoc commands shown as edits](https://raw.githubusercontent.com/FammasMaz/pi-cc-tools/master/docs/media/shell-edits.png)

## Spinner

While a tool runs, the working line names it: `Running npm test…`, `Reading stats.py…`, `Searching for TODO…`, `Waiting for agent: Find edge cases…`. While the model thinks, it shows a playful verb instead. The token count covers everything the model writes for the request, including thinking and tool arguments, and counts up smoothly as text streams in.

The terminal tab or window title also shows the latest execution step. It uses a declared `display.name` (such as Fabric's milestone) or `displaySummary` when available, otherwise the same tool activity descriptions as the working line. A named execution keeps its title while nested tools run. Once the full task settles, the title changes to `✓` followed by the first non-empty line of the final response as plain text (or `✓ Completed` for an empty response). Terminal titles do not render Markdown, so formatting markers are removed and links use their visible text. Failed or aborted runs keep the latest step. The title stays until the next step and is restored from the current branch on resume or reload. This runs only in interactive terminal sessions. Set `"terminalTitle": false` in settings to disable these title updates and stop saving new title entries; run `/reload` after editing the setting.

![The working line during a run](https://raw.githubusercontent.com/FammasMaz/pi-cc-tools/master/docs/media/spinner.gif)

## Bash labels

With labels on, a bash row shows what the command is for instead of the command itself: `Bash Run the test suite` rather than `Bash python3 -m unittest -q 2>&1 | tail -4`. The label is plain text, so it reads differently from a command. Click the row or press `Ctrl+O` to see the full command and its output.

![Labelled bash rows, and one clicked open to show its command](https://raw.githubusercontent.com/FammasMaz/pi-cc-tools/master/docs/media/bash-labels.gif)

`/cc-tools intent` picks where labels come from:

- `model` (default since 1.0.112): the model writes the label as an extra argument of each bash call. This adds a field to the bash tool and a line to the model's instructions. There is no extra request; the label costs a few output tokens on each call. Set `"bashIntent": "off"` (or run `/cc-tools intent off`) to go back to plain commands.
- `local`: Apple's on-device model writes the label on your Mac, so nothing the model sees changes. It needs macOS 26 or newer on Apple silicon with Apple Intelligence turned on, and the Xcode command line tools for a one-time build of a small helper. The row shows the command until the label arrives, about 0.3 to 0.6 seconds after the command starts. Labels are cached, so a resumed session shows them without asking again.

The choice applies on the next start or after `/reload`, because the model mode changes the bash tool itself. Collapsed groups show only the sentence summary; expand a group to see each command's label.

## Thinking

By default (`live`), thinking is shown while it streams and then collapses to `Thought for 3s`. A small dot spinner marks live thinking, distinct from the working line's star spinner. Click the row to read it again.

`/cc-tools thinking latest` goes further: only the latest message keeps its thinking. Earlier messages drop it, so the tool calls that thinking used to separate merge into one row. This changes only what is drawn; the thinking stays in the session and in the model's context. `/cc-tools thinking full` keeps every thinking block expanded, as stock pi does.

![The same session in live and latest thinking modes](https://raw.githubusercontent.com/FammasMaz/pi-cc-tools/master/docs/media/thinking-modes.png)

## Colors from your terminal

On pi 1.4 and newer the extension switches pi to its built-in `system` theme, which builds all of pi's colors from the palette your terminal reports. It works in Ghostty, Rex, kitty, WezTerm and other terminals that answer color queries. pi follows light and dark switches on its own. Terminals send nothing when you switch between two dark themes (or two light ones), so the extension also re-reads the palette whenever the terminal window regains focus.

![pi following the terminal through six themes](https://raw.githubusercontent.com/FammasMaz/pi-cc-tools/master/docs/media/terminal-themes.gif)

The extension's own colors follow the active theme as well. Diff code uses the theme's syntax colors, diff backgrounds are tinted from the theme's added and removed colors, and connectors keep the same faint contrast on any background.

Your previous theme is saved when the extension switches. `/cc-theme terminal off` restores it and keeps it, and `pi --use-theme <name>` still picks the theme for a single run.

## Subagents

With [pi-subagents](https://github.com/tintinweb/pi-subagents), `Agent` calls get the same treatment. Parallel agents fold into `Launching 2 agents…`, the spinner names the agent it is waiting for, and the expanded row shows each agent's tool uses, tokens, time and result. Completion notices and the Agents panel use the same dots and connectors as tool rows.

![Two agents reviewing a project](https://raw.githubusercontent.com/FammasMaz/pi-cc-tools/master/docs/media/subagents.gif)

## Smaller things

- Past prompts are a single highlighted line starting with `❯`, and the input line gets the same marker.
- In pi's fullscreen mode, selecting text copies only the text: code box borders, the indent pi adds to code, and the `●`, `❯` and `∴` markers in front of replies, prompts and thinking stay out of the clipboard. In regular mode the terminal does the copying, so it copies what is on screen.
- LaTeX math in replies is shown with Unicode symbols.
- RTK command rewrites appear as a muted `(RTK)` badge on the bash row.
- `apply_patch` calls show their parsed patch as a diff before they run.

## Commands

| Command | What it does |
| --- | --- |
| `/cc-tools` | Show the current tool settings |
| `/cc-tools outlines`, `transparent`, `default` | Tool row style: rules around each tool, no rules (default), or pi's own backgrounds |
| `/cc-tools group on`, `off`, `toggle` | Fold consecutive tool calls into one row |
| `/cc-tools thinking live`, `full`, `latest` | How finished thinking is shown |
| `/cc-tools intent off`, `model`, `local`, `status` | Where bash labels come from; applies after `/reload` |
| `/cc-tools detail on`, `off`, `toggle` | Higher preview limits, same as `Ctrl+Shift+O` |
| `/cc-theme terminal on`, `off`, `status` | Follow the terminal's colors, or go back to your previous theme |
| `/cc-theme on`, `off`, `toggle`, `status` | Derive the extension's colors from the pi theme, or use a fixed Claude palette |
| `/cc-spinner preview` | Show the theme colors available for the spinner |
| `/cc-spinner verb <key>`, `status <key>`, `reset` | Recolor the spinner's verb or its status text |

Commands that change a setting save it to the settings file, and the change applies right away.

## Settings

Settings are read from `.pi/settings.json` in the project and from the agent settings file, `$PI_CODING_AGENT_DIR/settings.json` (by default `~/.pi/agent/settings.json`). The values below are the defaults.

```json
{
  "toolBackground": "transparent",
  "groupToolCalls": true,
  "thinkingMode": "live",
  "terminalTheme": true,
  "terminalTitle": true,
  "themeAdaptive": true,
  "readOutputMode": "preview",
  "searchOutputMode": "preview",
  "mcpOutputMode": "preview",
  "bashOutputMode": "opencode",
  "bashIntent": "model",
  "previewLines": 8,
  "codemodePreviewLines": 5,
  "expandedPreviewMaxLines": 4000,
  "extraExpandedPreviewMaxLines": 12000,
  "extraToolOutputExpanded": false,
  "bashCollapsedLines": 10,
  "bashCommandPreviewLines": 0,
  "liveToolPreview": false,
  "liveToolPreviewLines": 5,
  "diffCollapsedLines": 24,
  "diffLayout": "auto"
}
```

The screenshots on this page use `"toolBackground": "transparent"`.

Codemode and [Pi Fabric](https://github.com/fabric-runtime/pi-fabric) (`fabric_exec`) stay outside tool groups so their previews remain visible. Script and output each get their own `codemodePreviewLines` budget, counted after wrapping to the terminal width; headings, status and truncation hints are extra. Click or press `Ctrl+O` to expand using the existing expanded preview limits. Fabric rows show the declared `display.name` when available and preserve the program's output. After editing this setting, run `/reload`.

Scripts use pi's built-in highlighting and syntax colors: JavaScript for codemode, TypeScript for Fabric, or Python when recorded in the Fabric result. Each streamed update appears highlighted immediately. Identical scripts share cached work across rows, redraws and resizing. Scripts over 32,000 characters keep a plain preview to bound tokenization cost.

### Layout

| Setting | Default | Description |
| --- | --- | --- |
| `toolBackground` | `transparent` | `transparent` draws no rules, `outlines` draws a rule above and below each tool (`border` also works), `default` keeps pi's tool backgrounds |
| `groupToolCalls` | `true` | Fold consecutive tool calls into one row |
| `thinkingMode` | `live` | `live` collapses finished thinking to `Thought for Xs`, `full` keeps it expanded, `latest` hides it in all but the latest message |
| `terminalTitle` | `true` | Show the latest execution step and final response summary in the terminal title. `false` disables extension title writes and saving new title entries; run `/reload` after editing |
| `previewLines` | `8` | Lines in a collapsed preview |
| `codemodePreviewLines` | `5` | Visible terminal lines in each collapsed codemode or Fabric script and output preview; `0` hides both previews. Accepts non-negative integers; invalid values use `5` |
| `expandedPreviewMaxLines` | `4000` | Line limit when a row is expanded |
| `extraExpandedPreviewMaxLines` | `12000` | Line limit in `Ctrl+Shift+O` mode |
| `extraToolOutputExpanded` | `false` | Start in `Ctrl+Shift+O` mode |

### Tool output

| Setting | Values | Default |
| --- | --- | --- |
| `readOutputMode` | `hidden`, `summary`, `preview` | `preview` |
| `searchOutputMode` | `hidden`, `count`, `preview` | `preview` |
| `mcpOutputMode` | `hidden`, `summary`, `preview` | `preview` |
| `bashOutputMode` | `opencode`, `summary`, `preview` | `opencode` |

| Setting | Default | Description |
| --- | --- | --- |
| `bashIntent` | `model` (since 1.0.112) | Labels on bash rows in place of the command. `model` (the model writes them; changes the bash tool and its instructions), `local` (Apple's on-device model writes them on this Mac), or `off` for plain commands as before 1.0.112. `true` means `model`. Applies on the next start or `/reload` |
| `bashCollapsedLines` | `10` | Output lines shown for a collapsed bash row |
| `bashCommandPreviewLines` | `0` | Lines of a multi-line command shown under a running or failed bash row. `Ctrl+O` always shows the whole command |
| `liveToolPreview` | `false` | Show the latest output lines under a running tool |
| `liveToolPreviewLines` | `5` | Lines in that live preview |
| `diffCollapsedLines` | `24` | Diff lines shown before a diff collapses |
| `diffLayout` | `auto` | `auto` uses the side-by-side layout only when it fits, `split` uses it whenever both sides fit, `unified` always stacks |

### Colors

| Setting | Default | Description |
| --- | --- | --- |
| `terminalTheme` | `true` | Use pi's `system` theme, built from the terminal's palette (pi 1.4+) |
| `themeAdaptive` | `true` | Derive diff colors, connectors and the spinner from the active pi theme. `false` uses a fixed Claude palette with light/dark variants |
| `diffTheme` | unset | A Shiki theme for diff code, such as `github-dark`. Unset uses the pi theme's syntax colors |
| `diffColors` | unset | Override individual diff colors |
| `spinnerVerbColor` | `borderAccent` | Theme color of the spinner's verb |
| `spinnerStatusColor` | `muted` | Theme color of the spinner's status text |

With `themeAdaptive` on, colors come from these pi theme tokens:

| Element | Source |
| --- | --- |
| Diff code | the theme's `syntax*` colors, the same ones pi uses for code blocks |
| Diff markers and backgrounds | `toolDiffAdded` and `toolDiffRemoved`, tinted over the terminal background |
| Connectors (`├ └ │`) and outlines | the terminal background blended toward its text color, to a 2:1 and a 5.1:1 contrast |
| Light or dark variants | pi's own `theme.appearance` |
| `Thought for Xs`, `Turn took Ns` | `muted` |

pi before 1.4 does not expose concrete theme colors. There, diffs fall back to `github-dark` or `github-light`, and connectors keep the same contrasts measured against black or white.

## Notes

The extension targets recent pi versions, where tool renderers receive `renderCall(args, theme, context)` and `renderResult(result, { expanded, isPartial }, theme, context)`. pi has no public hook for restyling tools that other extensions register, so the extension patches pi's container rendering to give every tool row the same frame.

## Credits

This project builds on the work of:

- [@heyhuynhgiabuu/pi-pretty](https://github.com/buddingnewinsights/pi-pretty) by [huynhgiabuu](https://github.com/buddingnewinsights): syntax-highlighted file reads, colored bash output and tree-view directory listings
- [@heyhuynhgiabuu/pi-diff](https://github.com/buddingnewinsights/pi-diff) by [huynhgiabuu](https://github.com/buddingnewinsights): the Shiki diff renderer with word-level changes in split and unified views
- [pi-tool-display](https://github.com/MasuRii/pi-tool-display) by [MasuRii](https://github.com/MasuRii): compact tool rows, diff display and output truncation
- [pi-polish](https://github.com/Pringled/pi-extensions/tree/main/packages/pi-polish) by [Thomas van Dongen](https://github.com/Pringled): the one-sentence tool groups, the activity spinner and the `❯` prompt markers follow its design
