# Link Structure
An Obsidian plugin for managing link-based note hierarchies. Adds a Structure view for Bases that displays notes as a draggable tree, built on the up property.

<img width="1089" height="937" alt="image" src="https://github.com/user-attachments/assets/90291a90-370c-4949-96d9-49ed4a98aded" />


# Why
Obsidian has a file manager for folder hierarchies, but nothing comparable for link-based ones. Bases Link Structure fills that gap — letting you both visualize and edit your hierarchy, with the added benefits of links:
A file can have multiple parents, appearing in several branches at once.
You can link files directly to each other without folders, making the folder notes plugin unnecessary.

# How it works
Each file has an up property (configurable in view settings) that stores a link to one or more parent files. The plugin uses these links to build the tree.

# Features
Structure view — displays your vault as a hierarchical tree based on up links.
Drag and drop — move files in the tree; links update automatically. Hold Ctrl to copy to a new location without removing from the old one.
Multi-select — hold Shift to select multiple files and move them together; all links update at once.
Active file highlight — a button reveals the current file in the tree. If it appears in multiple places, each press jumps to the next one. (Requires the view to be placed in the sidebar.)
Obsidian-native — respects system link settings (wiki/markdown, absolute/relative/shortest path). Uses standard Bases filters to control which notes are shown.
Quick note creation — add subnotes via the context menu, with optional Templater template support.

# Known issues
Complex Templater templates may cause conflicts. Avoid renaming or moving files from within a template.

# Installation
- Plugin is not available in [the official Community Plugins repository](https://obsidian.md/plugins) yet.
- Сan be installed through [BRAT](https://obsidian.md/plugins?id=obsidian42-brat).
