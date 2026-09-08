# AGENTS.md

Some project-specific instructions.

Here's what ArmorOpenCode's managed section looks like, documented inside a
fenced code block. These marker lines DO start at column 0, but they're
inside a fence, so they must NOT be treated as a real managed section:

```markdown
<!-- ARMOROPENCODE:START (managed by scripts/install.ts — do not edit this section by hand) -->
## ArmorOpenCode

This is documentation, not a live section.
<!-- ARMOROPENCODE:END -->
```

And the same thing as an indented example (also not a live section):

    <!-- ARMOROPENCODE:START (managed by scripts/install.ts — do not edit this section by hand) -->
    ## ArmorOpenCode
    Indented documentation, not a live section.
    <!-- ARMOROPENCODE:END -->

## Build

Run `bun test` before committing.
