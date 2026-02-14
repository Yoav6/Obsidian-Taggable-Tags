This file has a lot of features and some obscure edge cases, so everything that doesn't go in [[README]] goes here.


### Filtering

#### Circular relationship
When filtering for a tag that is part of a circular relationship, all its "decendants" are shown except it.

If you see "merge tag into parent" in the context menu of a tag in the root, it's because it's part of a circular relationship.

#### Filtering for a tag and its parent tags
Only items that are directly tagged with both tags will be shown. For example:
> A is tagged with B and C, B is tagged with C. Filter by B and C.


### Folder–tag sync

#### New folders named "untitled" don't get a tag file
When you create a new folder, Obsidian gives it the default name "untitled". The plugin does **not** auto-create an `untitled.md` tag file in that case, so you don't get an unwanted tag file before you've renamed the folder. When you **rename** it, the plugin then creates the corresponding tag file.

#### I want a tag named #untitled
You can still have an `#untitled` tag. Create the tag file yourself: create a note, add your tag property (e.g. `tag: untitled`), and save it as `untitled.md` or place it in an `untitled/` folder. The plugin only skips **auto**-creating a tag file when a folder is created with the default name "untitled"; it doesn't prevent you from using that tag name.
