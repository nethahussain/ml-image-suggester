# Image Suggester for Malayalam Wikipedia

A user script for [ml.wikipedia.org](https://ml.wikipedia.org) that helps illustrate image-less
articles. When you view a mainspace article that has **no image** but has an **English Wikipedia
counterpart**, a floating **"📷 ചിത്രനിർദ്ദേശങ്ങൾ"** button (and a toolbox link) appears. Clicking it
shows the free images used in the English article, and one click adds your chosen image to the
Malayalam article — in the right place.

It also finds work for you: a **"ചിത്രമില്ലാത്ത ലേഖനങ്ങൾ"** toolbox link (available on every page)
opens a finder that scans articles and lists only the actionable ones — image-less on mlwiki,
with an English counterpart that has at least one free image.

## What counts as "image-less"

An article is image-less only if **none of its real image files exist**. Instead of trusting the
PageImages extension, the script lists the files actually used on the page (`prop=images`),
keeps only true image types (`.jpg/.png/.gif/.svg/.tiff/.webp/.xcf`), drops meta/maintenance
icons, and checks each remaining file for existence. Consequences:

- A **broken infobox image link** (a `File:` that doesn't exist) still counts as image-less — and
  is a prime target for repair.
- An article whose only media is a **trailer video or audio clip** still counts as image-less.
- An article with **any real image** — including a locator map or a Commons-hosted photo — is
  skipped. (Commons files report `missing` locally but carry `known:true`; the script treats
  those as existing, which is essential — otherwise every Commons image would look missing.)

## What it does

1. On each mainspace article view, one API call lists the page's files and checks for an `en`
   langlink; a second call checks which of those image files exist. If the article has a real
   image, or no English counterpart, the script stays silent.
2. On demand, it fetches the English article's media list
   (`en.wikipedia.org/api/rest_v1/page/media-list/…`) and filters it against **Wikimedia
   Commons**: files that exist only locally on English Wikipedia (fair-use / non-free) are
   excluded automatically, since they cannot be used on Malayalam Wikipedia.
3. The panel shows each candidate with a thumbnail, its Commons license, the English caption
   prefilled in an editable box (translate to Malayalam before inserting), and a **ചേർക്കുക**
   button. The English lead image is badged **പ്രധാന ചിത്രം** and sorted first. A **← back** button
   lets you leave without editing (returns to the finder you came from). Each caption box has an
   **A / അ** toggle: switch it on and type Malayalam phonetically in Latin letters, switch it off to
   type English again. The transliteration follows Malayalam Wikipedia's own **ml-transliteration
   (മൊഴി)** scheme and is self-contained (no dependency on ULS/jQuery.IME). A few conventions worth
   knowing: `t`→റ്റ, `tt`→ട്ട, `th`→ത, `T`→ട; `nt`→ന്റ (എന്റെ = `ente`), `nth`→ന്ത (എന്ത് = `enth`);
   long vowels double or capitalise (`aa`/`A`→ആ, `ee`→ഈ, `E`→ഏ, `O`→ഓ); sibilants follow the
   Wikipedia scheme — `s`→സ, `S`→ശ, `sh`→ഷ, `Sh`→ഴ, `z`→ശ, `zh`→ഴ, `x`→ക്ഷ; `N`→ണ, `L`→ള.
   Examples: `malayaaLam`→മലയാളം, `analitikkal`→അനലിറ്റിക്കൽ, `kuTTi`→കുട്ടി, `Siva`→ശിവ.
4. **Placement is automatic** — inserting chooses where the image belongs from the wikitext:
   - if the article has a **broken file link**, the dead filename is replaced in place (this
     repairs a broken infobox image);
   - else if there is an **empty infobox `image=` parameter**, it is filled (and an empty
     `caption=` alongside it, if present);
   - else if there is an **infobox with no image field at all**, `image=` and `caption=`
     parameters are added inside it (just before its closing braces). "Infobox" here includes
     the taxonomy/chemistry/etc. `*box` families — Taxobox, Speciesbox, Drugbox, Chembox,
     Geobox, Starbox — not only templates literally named "Infobox";
   - else a **lead thumbnail** `[[പ്രമാണം:<file>|ലഘുചിത്രം|<caption>]]` is added after any leading
     maintenance templates.
   The edit summary names the English source and which placement was used. The infobox is located
   by brace-matching, so nested templates in a parameter value (e.g. `{{coord|…}}`) don't confuse
   where the box ends.

## Finding articles to illustrate

The finder **auto-continues**: one click keeps pulling batches (40 at a time) until it has
collected about 6 actionable suggestions, or it has scanned ~500 articles / 20 batches — so you
rarely have to click through empty batches yourself. A **കൂടുതൽ കാണിക്കുക** (show more) button then
fetches the next round.

The finder also **stays open across page loads** (its mode, query and results are saved in
`sessionStorage`) until you close it with **✕**. So you can click a result, land on that article,
add the image, and the finder is still there to pick the next one — no need to reopen it for every
page. It sits in the **lower-left corner** so it doesn't cover the suggestion panel on the right.
When you add an image to an article, the finder **drops that article from its list** (keeping the
others in place) and **refills** with fresh image-less articles, so the list stays useful as you
work through it.

It offers four sources:

- **എല്ലാ ലേഖനങ്ങളും** — random mainspace articles (sampled in batches).
- **വ്യക്തികൾ** — people, both living and dead, via a **random-sorted `deepcat` search** of the
  People category tree (`deepcat:"വ്യക്തികൾ"`, ~23k articles). Random sampling means the image-less
  ones surface quickly (roughly a third of a batch qualifies) instead of hitting well-illustrated
  celebrities first. The People tree also sweeps in a few non-individuals (ethnic groups, some
  institutions), which is harmless — they still get relevant image suggestions.
- **പ്രവർത്തനരഹിതമായ ചിത്രക്കണ്ണിയുള്ളവ** — articles in MediaWiki's "broken file links" tracking
  category (their infobox/inline image points to a non-existent file); no query needed.
- **ഒരു വർഗ്ഗത്തിൽ നിന്ന്** — members of a category (the `വർഗ്ഗം:` prefix is optional; the field
  autocompletes category names as you type, via a native dropdown).
- **തിരയൽ ഫലങ്ങളിൽ നിന്ന്** — full-text search results for a query.

Each batch is filtered in two stages: (1) mlwiki articles that are image-less (by the strict test
above) and have an `en` langlink, then (2) an English-side check that the article has a **free
lead image which is hosted on Wikimedia Commons**. This second point matters: a free image that
was uploaded *locally* to English Wikipedia (`imagerepository=local`, common for portraits of
Indian subjects) cannot be used on Malayalam Wikipedia, so such articles are dropped — otherwise
clicking through would open a panel with "no suitable images". Results show the Commons lead
image as a teaser; clicking one opens the Malayalam article with the suggestion panel already
open (via a `#imgsug` URL fragment).

## Installation

1. Create `ഉപയോക്താവ്:Netha Hussain/image-suggester.js` on ml.wikipedia.org and paste the
   contents of [`image-suggester.js`](image-suggester.js).
2. Add to your `common.js` on ml.wikipedia.org:

   ```js
   mw.loader.load('https://ml.wikipedia.org/w/index.php?title=ഉപയോക്താവ്:Netha_Hussain/image-suggester.js&action=raw&ctype=text/javascript');
   ```

## Notes & limitations

- Captions are prefilled in English from the enwiki article — translate them before inserting.
- Infobox detection targets the common `image=` / `ചിത്രം=` parameter and `caption=` /
  `അടിക്കുറിപ്പ്=`. Infoboxes using other parameter names fall back to a lead thumbnail.
- Editing uses `basetimestamp`, so a conflicting edit made while the panel is open fails safely
  instead of overwriting.
- After you update the on-wiki script, MediaWiki's ResourceLoader may serve the previous copy for
  a few minutes; a hard refresh loads the new version.

## Development

Source of truth lives here (OneDrive `Desktop/ml-image-suggester/`); copy to the wiki page when
you change it. Syntax check locally with `node --check image-suggester.js`.
