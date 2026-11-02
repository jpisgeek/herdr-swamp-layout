# Install the Swamp layout on another machine

## You need

- Herdr 0.1.12 or later. Start it one time before you install.
- The `swamp` CLI on `PATH` or in `~/.local/bin`.
- macOS or Linux with `sh`.

## Steps

1. Clone this repo (or copy the folder) to the machine.
2. Go to its parent folder:

   ```sh
   cd <parent of herdr-swamp-layout>
   ```

3. Run the install script:

   ```sh
   sh herdr-swamp-layout/install.sh
   ```

   The script copies these files into `~/.config/herdr-app`:
   - `layouts/swamp.json` and `layouts/swamp.svg`
   - `themes/swamp-club.json`
   - five mods: `swamp-approvals`, `swamp-runs`, `swamp-quickrun`, `swamp-tabs` and `swamp-status`. The `swamp-tabs` mod holds the Chakra Petch font.

   The script then checks each mod and switches Herdr to the swamp layout.

4. To go back to your previous layout, push Ctrl-Shift-L.

## The script does not overwrite

If one of these names already exists, the script stops and copies nothing. Remove or rename the old files, then run the script again.

## Change the watched repos

The panels watch each open space whose folder has a `.swamp.yaml` file. To watch a repo with no open space, add its path to this line in three files:

```js
const REPOS = ["~/path/to/swamp-repo"];
```

The three files are `mods/swamp-approvals/main.js`, `mods/swamp-runs/main.js` and `mods/swamp-quickrun/main.js`. Herdr loads the change immediately.

## Do not select the theme in the menu

The layout file sets the "swamp-club" theme for dark mode. Do not select "swamp-club" in the theme menu. Herdr files it as a light theme, and then dark mode shows a different theme.

## Remove

Delete the files that step 3 copied, and switch to another layout.

## More information

`RECIPE.md` tells how the layout looks, how it behaves and how it is built.
