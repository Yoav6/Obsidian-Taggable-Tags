**This plugin is in alpha, test it in a test vault or a copy of your vault before installing it in any importent vault**

# Taggable Tags

A powerful Obsidian plugin turning tags into taggable tag notes, while synchronizing between your tag hierarchy and folder hierarchy.

## Philosophy
- Folders are unatural for categorizing knowledge. Every group can be a part of multiple other groups.
- Tags should be notes. Every note can become a tag. Your tag hierarchy is a note hierarchy.
- Create notes without thinking of categorization, and categorize as you go. Don't plan ahead.
- Don't count on always and everyone having software that parses tagged tags. Maintain a fallback folder organization.

## Main Features

- **Tag Notes**: Create notes that corrospond to a tag in your vault by adding a "tag" property to the note with the tag's name. When hovering over a tag and holding ctrl, you will see a preview of that note. Ctrl + left-click will open the note.
- **Automatic tag note creation**: When you use a new tag anywhere in your vault, automatically create a corresponding tag note file is.
- **Tag hierarchy via tags**: Tag your tags by adding tags to the tag's note and the plugin will automatically index all the child-parent relatioships between tags and files. This allows a many-to-many relationship between tags (unlike nested tags which are strictly hierarchical).
- **Tag Explorer view**: Explore this structure with a file-explorer-like sidebar view that shows your tags as both folders and notes (like in the folder notes plugin). Each tag can be clicked to open its corrosponding note, and expanded to show its child tags and notes. Items with multiple parents appear under each parent.
- **Filtering**: Add tags as positive or negative filters to search and view only a subset of your tag tree. Click a tag in a note frontmatter or body to add it as a filter.
- **Rename sync**: If you change the tag property in a tag file, all usages of that tag throughout your vault are updated. You can also use the "Rename tag" command to rename a tag everywhere at once.
- **Folder syncronization**: recreate your tag hierarchy as a folder hierarchy based on the first tag of each note, so if you or someone else ever needs to access your notes without access to software which cannot parse tags, a sensible hierarchy will still exist, and mirror your folder structure in tags so oyu can still interact with folder without breaking the tag-folder corrospondence.
- **Tag manipulation**: There's a bunch of useful tag manipulation features like deleting, splitting, combining, rearranging, and renaming tags which means you never have to think about your tag hierarchy in advance of creating notes or tags.
- **Migration utilities**: Since most users will want to use this plugin with a collction of notes that is currently based on folders for organization, the plugin has features that let you easily trnasition from one workflow to the other.

## How it works

### Tag file detection

Tag files are identified by a frontmatter property (default: `tag`). The value of this property determines which tag the file represents. This means:

- File names can differ from tag names (the file `Python Language.md` can represent the tag `#python`)
- Changing the `tag` property value will rename the tag throughout your vault
- You can organize tag files in any folder structure you prefer

### Example

1. Use any tag in your notes, e.g., `#python`
2. A tag file is automatically created with a `tag` property:

```yaml
---
tag: python
tags: []
---
```

3. Edit that file to add parent tags:

```yaml
---
tag: python
tags: [programming-languages, data-science-tools]
---
```

4. Now `#python` appears under both `#programming-languages` and `#data-science-tools` in the Tag Explorer

## More features

- **Tag Manipulation**
    - **Create child/parent tag**: Context menu action to create a new note and make it either a child or a parent tag of the current tag.
    - **Merge tag into parents**: Context menu action for tags with one parent which deletes the tag and replaces all its instances with instances of its parent.
    - **Split tag**: Context menu action for tags with multiple parents which deletes the tag and replaces all its instances with instances of its parents.
    - **Create tag from filters**: Option that appears when filtering for two or more tags. Creates a new tag and replaces all instances of the tags with it in files which apply to the filters. Can be reversed with "split tag".
    - **Rearrange tag order**: A command that lets you change the order tags are listed in the active note (since obsidian doesn't have a good native way to do that). This is mainly useful for the folder syncronization feature which is based on tag order. Otherwise tag order doesn't matter.
- ****:

More obscure features and details are covered in Q&A.md

### Commands

- **Open tag explorer**: Opens the Tag Explorer sidebar view
- **Rearrange tags**: 


## Settings

- **Auto-create tag files**: Automatically create tag files for new tags (default: on)
- **Confirm orphan deletion**: Show a prompt when a tag file becomes orphaned (default: on)
- **Force lowercase tags**: Automatically convert all tags to lowercase (default: on)
- **Tag property name**: The frontmatter property that identifies tag files (default: `tag`)
- **Sync file names with tag names**: When enabled, renaming a tag file will update its tag property, and changing the tag property will rename the file (default: off)

