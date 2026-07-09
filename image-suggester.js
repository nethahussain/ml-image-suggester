/**
 * Image Suggester for Malayalam Wikipedia
 * ----------------------------------------
 * On articles that have no images, suggests the images used in the
 * corresponding English Wikipedia article (Commons-hosted only) and
 * lets you insert one with a Malayalam caption in a single click.
 *
 * Also includes a finder ("ചിത്രമില്ലാത്ത ലേഖനങ്ങൾ" in the toolbox on any
 * page) that scans random articles, a category or search results for
 * image-less articles whose English counterpart has free images.
 *
 * Install: add to [[ഉപയോക്താവ്:<You>/common.js]] on ml.wikipedia.org:
 *   mw.loader.load('https://ml.wikipedia.org/w/index.php?title=ഉപയോക്താവ്:Netha_Hussain/image-suggester.js&action=raw&ctype=text/javascript');
 *
 * How it works:
 *   1. On a mainspace article, one API call lists the files actually used
 *      on the page and checks for an enwiki langlink. The article counts
 *      as image-less only if none of its (non-icon) files exist — a broken
 *      infobox image link therefore still counts as image-less.
 *   2. If the article is image-less and an English counterpart exists, a
 *      floating button and a toolbox link appear.
 *   3. Clicking fetches the English article's media list (REST API),
 *      keeps only images that exist on Wikimedia Commons (fair-use files
 *      local to enwiki are excluded automatically), and shows them with
 *      thumbnails, captions and licenses.
 *   4. "ചേർക്കുക" places the image where it belongs: it repairs a broken
 *      file link in place, else fills an infobox image= parameter, else
 *      adds a lead thumbnail — with an informative edit summary.
 *   5. The finder can also scan the "broken file links" tracking category.
 *
 * Author: Netha Hussain
 * License: MIT
 */
/* global mw, $ */
(function () {
	'use strict';

	if (mw.config.get('wgDBname') !== 'mlwiki') { return; }

	var PAGE = mw.config.get('wgPageName');
	var SCRIPT_LINK = '[[ഉപയോക്താവ്:Netha Hussain/image-suggester.js|image-suggester]]';
	// Meta/icon files that appear in enwiki articles but are never useful here.
	var JUNK = /(OOjs|Commons-logo|Wik(i|t)ionary|Wikiquote|Wikisource|Wikimedia|Wikispecies|Wikidata|Wikinews|Wikiversity|Wikibooks|Wikivoyage|Symbol_|Ambox|Padlock|Question_book|Text_document|Crystal_Clear|Increase|Decrease|Steady|Edit-clear|Red_pog|Green_pog|Blue_pog|_pog\.|Loudspeaker|Sound-icon|Star_full|Star_empty|Cscr-|P_vip|Disambig|Magnify-clip|Gtk-dialog|\.ogg$|\.oga$|\.mid$)/i;

	var api = null;
	var enTitle = null;
	var panel = null;
	var finder = null;
	var finderContinue = null;
	var finderRows = [];
	var brokenCat = null;
	var FINDER_KEY = 'imgsug-finder-open';

	function init() {
		api = new mw.Api();
		addStyles();
		addFinderLink();
		// The finder stays open across page loads until closed with ✕, so you
		// can illustrate several articles without reopening it each time.
		try { if (sessionStorage.getItem(FINDER_KEY)) { openFinder(); } } catch (e) {}

		// Suggestion flow only on mainspace article views.
		if (mw.config.get('wgNamespaceNumber') !== 0) { return; }
		if (mw.config.get('wgAction') !== 'view' || !mw.config.get('wgIsArticle')) { return; }
		if (mw.config.get('wgIsRedirect')) { return; }
		api.get({
			action: 'query',
			prop: 'images|langlinks',
			imlimit: 'max',
			lllang: 'en',
			lllimit: 1,
			titles: PAGE,
			formatversion: 2
		}).then(function (data) {
			var page = data.query && data.query.pages && data.query.pages[0];
			if (!page || page.missing) { return; }
			if (!page.langlinks || !page.langlinks.length) { return; } // no English counterpart
			var files = imageFilesOf(page);
			checkFilesExist(files).then(function (exists) {
				// Image-less only if none of the (non-icon) files actually exist.
				if (files.some(function (t) { return exists[t]; })) { return; }
				enTitle = page.langlinks[0].title;
				addEntryPoints();
				// Arriving from the finder: open the suggestions right away.
				if (location.hash === '#imgsug') { openPanel(); }
			});
		});
	}

	function addEntryPoints() {
		mw.util.addPortletLink('p-tb', '#', 'ചിത്രനിർദ്ദേശങ്ങൾ', 't-image-suggester',
			'ഇംഗ്ലീഷ് വിക്കിപീഡിയയിൽ നിന്നുള്ള ചിത്രനിർദ്ദേശങ്ങൾ കാണിക്കുക');
		$('#t-image-suggester').on('click', function (e) { e.preventDefault(); openPanel(); });

		$('<button>')
			.attr('id', 'imgsug-fab')
			.attr('title', 'ഈ ലേഖനത്തിൽ ചിത്രങ്ങളില്ല — ഇംഗ്ലീഷ് വിക്കിപീഡിയയിൽ നിന്നുള്ള നിർദ്ദേശങ്ങൾ കാണുക')
			.text('📷 ചിത്രനിർദ്ദേശങ്ങൾ')
			.on('click', openPanel)
			.appendTo(document.body);
	}

	// ---------- Finder: locate image-less articles worth illustrating ----------

	function addFinderLink() {
		mw.util.addPortletLink('p-tb', '#', 'ചിത്രമില്ലാത്ത ലേഖനങ്ങൾ', 't-image-suggester-find',
			'ചിത്രങ്ങളില്ലാത്ത, ഇംഗ്ലീഷ് വിക്കിപീഡിയയിൽ ചിത്രങ്ങളുള്ള ലേഖനങ്ങൾ കണ്ടെത്തുക');
		$('#t-image-suggester-find').on('click', function (e) { e.preventDefault(); openFinder(); });
	}

	function saveFinderState(mode, query) {
		try {
			sessionStorage.setItem(FINDER_KEY, JSON.stringify({
				mode: mode, query: query, rows: finderRows, cont: finderContinue
			}));
		} catch (e) {}
	}
	function clearFinderState() {
		try { sessionStorage.removeItem(FINDER_KEY); } catch (e) {}
	}

	function openFinder() {
		if (finder) { finder.show(); return; }
		var saved = null;
		try { saved = JSON.parse(sessionStorage.getItem(FINDER_KEY) || 'null'); } catch (e) { saved = null; }
		finderRows = (saved && saved.rows) || [];
		finderContinue = (saved && saved.cont) || null;

		finder = $('<div>').attr('id', 'imgsug-finder').addClass('imgsug-panel-base').appendTo(document.body);
		$('<div>').addClass('imgsug-head')
			.append($('<span>').text('ചിത്രമില്ലാത്ത ലേഖനങ്ങൾ'))
			.append($('<a>').addClass('imgsug-close').attr('href', '#').text('✕')
				.on('click', function (e) { e.preventDefault(); clearFinderState(); finder.remove(); finder = null; }))
			.appendTo(finder);

		var form = $('<div>').addClass('imgsug-form').appendTo(finder);
		var mode = $('<select>')
			.append($('<option>').val('random').text('എല്ലാ ലേഖനങ്ങളും'))
			.append($('<option>').val('people').text('വ്യക്തികൾ'))
			.append($('<option>').val('broken').text('പ്രവർത്തനരഹിതമായ ചിത്രക്കണ്ണിയുള്ളവ'))
			.append($('<option>').val('category').text('ഒരു വർഗ്ഗത്തിൽ നിന്ന്'))
			.append($('<option>').val('search').text('തിരയൽ ഫലങ്ങളിൽ നിന്ന്'))
			.appendTo(form);
		var query = $('<input>').attr('type', 'text')
			.attr('placeholder', 'വർഗ്ഗത്തിന്റെ പേര്')
			.hide()
			.appendTo(form);
		var catList = $('<datalist>').attr('id', 'imgsug-cats').appendTo(form);
		var catTimer = null;
		// Autocomplete category names while typing (native dropdown via <datalist>).
		query.on('input', function () {
			if (mode.val() !== 'category') { return; }
			var v = query.val().trim().replace(/^(വർഗ്ഗം|വിഭാഗം|Category):/i, '');
			clearTimeout(catTimer);
			if (!v) { catList.empty(); return; }
			catTimer = setTimeout(function () {
				api.get({
					action: 'query',
					list: 'allcategories',
					acprefix: v,
					aclimit: 10,
					formatversion: 2
				}).then(function (d) {
					catList.empty();
					((d.query && d.query.allcategories) || []).forEach(function (c) {
						$('<option>').attr('value', c.category).appendTo(catList);
					});
				});
			}, 250);
		});
		mode.on('change', function () {
			var m = mode.val();
			query.toggle(m === 'category' || m === 'search')
				.attr('placeholder', m === 'category' ? 'വർഗ്ഗത്തിന്റെ പേര്' : 'തിരയേണ്ട വാക്കുകൾ');
			if (m === 'category') { query.attr('list', 'imgsug-cats'); }
			else { query.removeAttr('list'); catList.empty(); }
			persist();
		});
		var go = $('<button>').addClass('imgsug-insert').text('കണ്ടെത്തുക').appendTo(form);

		var results = $('<div>').addClass('imgsug-body').appendTo(finder);
		var more = $('<button>').addClass('imgsug-insert imgsug-more').text('കൂടുതൽ കാണിക്കുക').hide()
			.appendTo(finder);

		// Keep pulling batches automatically until we have collected a useful
		// number of suggestions, so the user rarely has to click "show more".
		function persist() { saveFinderState(mode.val(), query.val()); }

		function run(reset, target) {
			if (reset) { results.empty(); finderContinue = null; finderRows = []; }
			more.hide();
			go.prop('disabled', true);
			var status = $('<div>').addClass('imgsug-status').appendTo(results);
			var found = 0, scanned = 0, batches = 0;
			var TARGET = target || 6, MAX_SCAN = 500, MAX_BATCHES = 20;
			function step() {
				status.text('തിരയുന്നു… (പരിശോധിച്ചത്: ' + scanned + ', കണ്ടെത്തിയത്: ' + found + ')');
				findBatch(mode.val(), query.val().trim()).then(function (r) {
					scanned += r.scanned;
					batches += 1;
					r.rows.forEach(function (row) {
						if (!finderRows.some(function (x) { return x.ml === row.ml; })) {
							finderRows.push(row);
							renderFinderRow(results, row);
							found += 1;
						}
					});
					var canContinue = r.hasMore && r.scanned > 0;
					if (found < TARGET && scanned < MAX_SCAN && batches < MAX_BATCHES && canContinue) {
						step();
					} else {
						status.text('പരിശോധിച്ചത്: ' + scanned + ' — കണ്ടെത്തിയത്: ' + found);
						go.prop('disabled', false);
						more.toggle(canContinue).off('click').on('click', function () { run(false); });
						persist();
					}
				}, function (msg) {
					status.text(msg || 'തിരയുന്നതിൽ പിഴവ് സംഭവിച്ചു.');
					go.prop('disabled', false);
				});
			}
			step();
		}
		go.on('click', function () { run(true); });
		query.on('keydown', function (e) { if (e.key === 'Enter') { run(true); } });

		// Restore a previous (persisted) session, or mark the finder as open.
		if (saved) {
			mode.val(saved.mode || 'random');
			query.val(saved.query || '');
			mode.trigger('change');
			// Drop an article that was just illustrated on this visit.
			var added = null;
			try { added = sessionStorage.getItem('imgsug-added'); sessionStorage.removeItem('imgsug-added'); } catch (e) {}
			if (added) {
				finderRows = finderRows.filter(function (row) { return row.ml.replace(/ /g, '_') !== added; });
			}
			finderRows.forEach(function (row) { renderFinderRow(results, row); });
			persist();
			if (added && finderRows.length < 6) {
				// Refill the list with fresh image-less articles.
				run(false, 6 - finderRows.length);
			} else {
				more.toggle(!!finderContinue).off('click').on('click', function () { run(false); });
			}
		} else {
			persist();
		}
	}

	// Stage 1 (mlwiki): pull a batch via the chosen generator, then keep only
	// articles that are image-less (none of their non-icon files exist) and
	// have an enwiki langlink. Broken links do not count as images.
	// Stage 2 (enwiki): keep only those whose English article has a free
	// page image (pilicense=free also drops fair-use-only articles).
	function findBatch(mode, queryText) {
		var prep = (mode === 'broken') ? ensureBrokenCat() : $.Deferred().resolve().promise();
		return prep.then(function () {
			var params = {
				action: 'query',
				prop: 'images|langlinks|info',
				imlimit: 'max',
				lllang: 'en',
				lllimit: 'max',
				formatversion: 2
			};
			if (mode === 'random') {
				params.generator = 'random';
				params.grnnamespace = 0;
				params.grnfilterredir = 'nonredirects';
				params.grnlimit = 40;
			} else if (mode === 'broken') {
				params.generator = 'categorymembers';
				params.gcmtitle = brokenCat;
				params.gcmnamespace = 0;
				params.gcmtype = 'page';
				params.gcmlimit = 40;
			} else if (mode === 'people') {
				// People — living and dead — via the People category tree,
				// sampled at random so image-less ones surface quickly.
				params.generator = 'search';
				params.gsrsearch = 'deepcat:"വ്യക്തികൾ"';
				params.gsrnamespace = 0;
				params.gsrlimit = 40;
				params.gsrsort = 'random';
			} else if (mode === 'category') {
				if (!queryText) { return $.Deferred().reject('വർഗ്ഗത്തിന്റെ പേര് നൽകുക.').promise(); }
				params.generator = 'categorymembers';
				params.gcmtitle = /^(വർഗ്ഗം|വിഭാഗം|Category):/i.test(queryText) ? queryText : 'വർഗ്ഗം:' + queryText;
				params.gcmnamespace = 0;
				params.gcmtype = 'page';
				params.gcmlimit = 40;
			} else {
				if (!queryText) { return $.Deferred().reject('തിരയേണ്ട വാക്കുകൾ നൽകുക.').promise(); }
				params.generator = 'search';
				params.gsrsearch = queryText;
				params.gsrnamespace = 0;
				params.gsrlimit = 40;
			}
			if (finderContinue) { $.extend(params, finderContinue); }

			return api.get(params).then(function (data) {
				finderContinue = data.continue || null;
				var pages = (data.query && data.query.pages) || [];
				var langlinked = pages.filter(function (p) {
					return !p.missing && !p.redirect && p.langlinks && p.langlinks.length;
				});
				var result = { scanned: pages.length, rows: [], hasMore: !!finderContinue };
				if (!langlinked.length) { return result; }

				// Strict image-less test: candidate only if none of its files exist.
				var allFiles = [];
				langlinked.forEach(function (p) { allFiles = allFiles.concat(imageFilesOf(p)); });
				return checkFilesExist(allFiles).then(function (exists) {
					var candidates = langlinked.filter(function (p) {
						return !imageFilesOf(p).some(function (t) { return exists[t]; });
					}).map(function (p) {
						return { ml: p.title, en: p.langlinks[0].title };
					});
					if (!candidates.length) { return result; }

					var enwiki = new mw.ForeignApi('https://en.wikipedia.org/w/api.php', { anonymous: true });
					return enwiki.get({
						action: 'query',
						redirects: 1,
						prop: 'pageimages',
						piprop: 'name|thumbnail',
						pilicense: 'free',
						pithumbsize: 120,
						pilimit: 'max',
						titles: candidates.map(function (c) { return c.en; }).join('|'),
						formatversion: 2
					}).then(function (data2) {
						var q = data2.query || {};
						// Map each requested title through normalization + redirects
						// to the title actually returned.
						var resolve = {};
						(q.normalized || []).concat(q.redirects || []).forEach(function (m) {
							resolve[m.from] = m.to;
						});
						var info = {};
						(q.pages || []).forEach(function (p) {
							if (p.pageimage && p.thumbnail) {
								info[p.title] = { name: p.pageimage, thumb: p.thumbnail.source };
							}
						});
						var pending = [];
						candidates.forEach(function (c) {
							var t = c.en;
							var hops = 0;
							while (resolve[t] && hops < 5) { t = resolve[t]; hops++; }
							if (info[t]) { pending.push({ ml: c.ml, en: c.en, name: info[t].name, thumb: info[t].thumb }); }
						});
						if (!pending.length) { return result; }
						// A "free" English image is only usable on mlwiki if it is on
						// Commons — enwiki-local free files (imagerepository=local) must
						// be dropped, else the suggestion panel would come up empty.
						var commons = new mw.ForeignApi('https://commons.wikimedia.org/w/api.php', { anonymous: true });
						return commons.get({
							action: 'query',
							prop: 'imageinfo',
							iiprop: 'timestamp',
							titles: pending.map(function (p) { return 'File:' + p.name; }).join('|'),
							formatversion: 2
						}).then(function (cd) {
							var onCommons = {};
							((cd.query && cd.query.pages) || []).forEach(function (p) {
								if (!p.missing) { onCommons[p.title.replace(/^[^:]+:/, '').replace(/_/g, ' ')] = true; }
							});
							pending.forEach(function (p) {
								if (onCommons[p.name.replace(/_/g, ' ')]) {
									result.rows.push({ ml: p.ml, en: p.en, thumb: p.thumb });
								}
							});
							return result;
						});
					});
				});
			});
		});
	}

	// The localized "pages with broken file links" tracking category.
	function ensureBrokenCat() {
		if (brokenCat) { return $.Deferred().resolve(brokenCat).promise(); }
		return api.get({
			action: 'query',
			meta: 'allmessages',
			ammessages: 'broken-file-category',
			formatversion: 2
		}).then(function (d) {
			var msg = (d.query && d.query.allmessages && d.query.allmessages[0] &&
				d.query.allmessages[0].content) || '';
			if (!msg) { return $.Deferred().reject('പ്രവർത്തനരഹിതമായ കണ്ണികളുടെ വർഗ്ഗം കണ്ടെത്താനായില്ല.').promise(); }
			brokenCat = /^(വർഗ്ഗം|വിഭാഗം|Category):/i.test(msg) ? msg : 'വർഗ്ഗം:' + msg;
			return brokenCat;
		});
	}

	// Non-icon image files linked on a page, as full "പ്രമാണം:X" titles.
	// Only true image types count — a trailer video or audio clip does not
	// make an article "illustrated".
	function imageFilesOf(page) {
		return ((page.images || []).map(function (i) { return i.title; }))
			.filter(function (t) { return /\.(jpe?g|png|gif|svg|tiff?|webp|xcf)$/i.test(t) && !JUNK.test(t); });
	}

	// Batch-check whether each file title exists (locally or on Commons).
	// Returns a promise for a { title: boolean } map. Chunked to 50 titles.
	function checkFilesExist(titles) {
		var uniq = [];
		var seen = {};
		titles.forEach(function (t) { if (!seen[t]) { seen[t] = 1; uniq.push(t); } });
		var exists = {};
		if (!uniq.length) { return $.Deferred().resolve(exists).promise(); }
		var chunks = [];
		for (var i = 0; i < uniq.length; i += 50) { chunks.push(uniq.slice(i, i + 50)); }
		return chunks.reduce(function (chain, chunk) {
			return chain.then(function () {
				return api.get({
					action: 'query',
					prop: 'imageinfo',
					iiprop: 'timestamp',
					titles: chunk.join('|'),
					formatversion: 2
				}).then(function (d) {
					((d.query && d.query.pages) || []).forEach(function (p) {
						// Commons-hosted (shared) files report missing:true locally
						// but carry known:true — treat those as existing.
						exists[p.title] = !p.missing || !!p.known;
					});
				});
			});
		}, $.Deferred().resolve().promise()).then(function () { return exists; });
	}

	function renderFinderRow(container, row) {
		var card = $('<a>').addClass('imgsug-row')
			.attr('href', mw.util.getUrl(row.ml) + '#imgsug')
			.appendTo(container);
		$('<img>').attr('src', row.thumb).attr('loading', 'lazy').appendTo(card);
		$('<div>')
			.append($('<div>').addClass('imgsug-name').text(row.ml))
			.append($('<div>').addClass('imgsug-license').text('en: ' + row.en))
			.appendTo(card);
	}

	// ---------- Suggestion panel ----------

	function openPanel() {
		if (panel) { panel.show(); return; }
		panel = $('<div>').attr('id', 'imgsug-panel').addClass('imgsug-panel-base').appendTo(document.body);
		$('<div>').addClass('imgsug-head')
			.append($('<a>').addClass('imgsug-back').attr('href', '#').attr('title', 'തിരികെ പോകുക').text('←')
				.on('click', function (e) { e.preventDefault(); history.back(); }))
			.append($('<span>').text('ഇംഗ്ലീഷ് വിക്കിപീഡിയയിൽ നിന്നുള്ള ചിത്രനിർദ്ദേശങ്ങൾ'))
			.append($('<a>').addClass('imgsug-close').attr('href', '#').text('✕')
				.on('click', function (e) { e.preventDefault(); panel.hide(); }))
			.appendTo(panel);
		$('<div>').addClass('imgsug-sub')
			.append('ഉറവിടം: ')
			.append($('<a>')
				.attr('href', 'https://en.wikipedia.org/wiki/' + encodeURIComponent(enTitle.replace(/ /g, '_')))
				.attr('target', '_blank')
				.text('en:' + enTitle))
			.appendTo(panel);
		var body = $('<div>').addClass('imgsug-body')
			.text('ലോഡ് ചെയ്യുന്നു…')
			.appendTo(panel);
		fetchSuggestions().then(function (images) {
			renderSuggestions(body, images);
		}, function (msg) {
			body.text(msg || 'ചിത്രങ്ങൾ ലഭ്യമാക്കുന്നതിൽ പിഴവ് സംഭവിച്ചു.');
		});
	}

	// Fetch the English article's media list, then keep only files that
	// exist on Commons (enwiki-local fair-use files come back "missing").
	function fetchSuggestions() {
		var restUrl = 'https://en.wikipedia.org/api/rest_v1/page/media-list/' +
			encodeURIComponent(enTitle.replace(/ /g, '_'));
		return $.getJSON(restUrl).then(function (data) {
			var items = (data.items || []).filter(function (it) {
				return it.type === 'image' && it.title && !JUNK.test(it.title);
			});
			if (!items.length) { return $.Deferred().reject('അനുയോജ്യമായ ചിത്രങ്ങളൊന്നും കണ്ടെത്താനായില്ല.').promise(); }
			items = items.slice(0, 50); // one Commons batch is plenty

			var byTitle = {};
			items.forEach(function (it) {
				byTitle[it.title.replace(/_/g, ' ')] = it;
			});
			var commons = new mw.ForeignApi('https://commons.wikimedia.org/w/api.php', { anonymous: true });
			return commons.get({
				action: 'query',
				prop: 'imageinfo',
				iiprop: 'url|size|extmetadata',
				iiextmetadatafilter: 'LicenseShortName',
				iiurlwidth: 320,
				titles: items.map(function (it) { return it.title; }).join('|'),
				formatversion: 2
			}).then(function (data2) {
				var images = [];
				(data2.query && data2.query.pages || []).forEach(function (p) {
					if (p.missing || !p.imageinfo || !p.imageinfo.length) { return; } // not on Commons
					var item = byTitle[p.title] || {};
					images.push({
						title: p.title,                                  // "File:Xyz.jpg"
						name: p.title.replace(/^[^:]+:/, ''),            // "Xyz.jpg"
						thumb: p.imageinfo[0].thumburl,
						descUrl: p.imageinfo[0].descriptionurl,
						license: (p.imageinfo[0].extmetadata &&
							p.imageinfo[0].extmetadata.LicenseShortName &&
							p.imageinfo[0].extmetadata.LicenseShortName.value) || '',
						caption: (item.caption && item.caption.text) || '',
						lead: !!item.leadImage
					});
				});
				if (!images.length) { return $.Deferred().reject('അനുയോജ്യമായ ചിത്രങ്ങളൊന്നും കണ്ടെത്താനായില്ല (കോമൺസിൽ ലഭ്യമല്ലാത്തവ ഒഴിവാക്കിയിരിക്കുന്നു).').promise(); }
				// Keep article order, lead image first.
				var order = items.map(function (it) { return it.title.replace(/_/g, ' '); });
				images.sort(function (a, b) {
					if (a.lead !== b.lead) { return a.lead ? -1 : 1; }
					return order.indexOf(a.title) - order.indexOf(b.title);
				});
				return images;
			});
		});
	}

	function renderSuggestions(body, images) {
		body.empty();
		images.forEach(function (img) {
			var card = $('<div>').addClass('imgsug-card').appendTo(body);
			$('<a>').attr('href', img.descUrl).attr('target', '_blank')
				.append($('<img>').attr('src', img.thumb).attr('loading', 'lazy'))
				.appendTo(card);
			var meta = $('<div>').addClass('imgsug-meta').appendTo(card);
			var nameRow = $('<div>').addClass('imgsug-name').text(img.name).appendTo(meta);
			if (img.lead) {
				nameRow.prepend($('<span>').addClass('imgsug-lead').text('പ്രധാന ചിത്രം'));
			}
			if (img.license) {
				$('<div>').addClass('imgsug-license').text(img.license).appendTo(meta);
			}
			var capRow = $('<div>').addClass('imgsug-caprow').appendTo(meta);
			var captionInput = $('<input>').attr('type', 'text')
				.attr('placeholder', 'അടിക്കുറിപ്പ് (മലയാളത്തിൽ)')
				.val(img.caption) // English caption prefilled — translate before inserting
				.appendTo(capRow);
			var xlit = $('<button>').addClass('imgsug-xlit').text('A')
				.attr('title', 'മലയാളം ലിപ്യന്തരണം ഓണാക്കുക (ഇംഗ്ലീഷിൽ ടൈപ്പ് ചെയ്യുക)')
				.appendTo(capRow);
			attachTransliteration(captionInput, xlit);
			$('<button>').addClass('imgsug-insert').text('ചേർക്കുക')
				.on('click', function () {
					var btn = $(this);
					btn.prop('disabled', true).text('ചേർക്കുന്നു…');
					insertImage(img.name, captionInput.val().trim()).then(function () {
						mw.notify('ചിത്രം ചേർത്തു. താൾ പുതുക്കുന്നു…');
						// Tell the finder to drop this article and refill the list.
						try { if (sessionStorage.getItem(FINDER_KEY)) { sessionStorage.setItem('imgsug-added', PAGE); } } catch (e) {}
						location.reload();
					}, function (code) {
						btn.prop('disabled', false).text('ചേർക്കുക');
						mw.notify('തിരുത്തൽ പരാജയപ്പെട്ടു: ' + code, { type: 'error' });
					});
				})
				.appendTo(meta);
		});
	}

	// Add the image to the article, choosing placement from its wikitext:
	//   • a broken file link is repaired in place (usually the infobox);
	//   • otherwise an empty infobox image= parameter is filled;
	//   • otherwise, if an infobox has no image field at all, image= and
	//     caption= parameters are added inside it;
	//   • otherwise a lead thumbnail is inserted after leading templates.
	function insertImage(fileName, caption) {
		return api.get({
			action: 'query',
			prop: 'revisions|images',
			rvprop: 'content|timestamp',
			rvslots: 'main',
			imlimit: 'max',
			titles: PAGE,
			formatversion: 2
		}).then(function (data) {
			var page = data.query.pages[0];
			var rev = page.revisions[0];
			var text = rev.slots.main.content;
			var files = imageFilesOf(page);
			return checkFilesExist(files).then(function (exists) {
				var brokenBare = files.filter(function (t) { return !exists[t]; })
					.map(function (t) { return t.replace(/^[^:]+:/, ''); });
				var placed = placeImage(text, fileName, caption, brokenBare);
				var how = placed.mode === 'broken' ? 'പ്രവർത്തനരഹിതമായ ചിത്രക്കണ്ണി ശരിയാക്കി'
					: placed.mode === 'infobox' ? 'വിവരപ്പെട്ടിയിൽ ചിത്രം ചേർത്തു'
						: 'ചിത്രം ചേർത്തു';
				return api.postWithEditToken({
					action: 'edit',
					title: PAGE,
					text: placed.text,
					summary: '[[:en:' + enTitle + ']]-ൽ നിന്നുള്ള ചിത്രം — ' + how + ' (' + SCRIPT_LINK + ' ഉപയോഗിച്ച്)',
					basetimestamp: rev.timestamp,
					nocreate: 1
				}).then(function (r) {
					if (!r.edit || r.edit.result !== 'Success') {
						return $.Deferred().reject((r.edit && r.edit.result) || 'unknown').promise();
					}
				});
			});
		});
	}

	// Decide where the new file goes and return { text, mode }.
	function placeImage(text, fileName, caption, brokenNames) {
		var safe = fileName.replace(/\$/g, '$$$$');
		// 1. Repair a broken file link in place (works for infobox or inline).
		for (var i = 0; i < brokenNames.length; i++) {
			var re = bareFileRegex(brokenNames[i]);
			if (re.test(text)) {
				return { text: fillCaptionParam(text.replace(re, safe), caption), mode: 'broken' };
			}
		}
		// 2. Fill an empty infobox image= parameter.
		var imgParam = /(\|[ \t]*(?:image|ചിത്രം)[ \t]*=)([ \t]*)([^\n|}]*)/i;
		var m = text.match(imgParam);
		if (m && !m[3].trim()) {
			var filled = text.replace(imgParam, '$1 ' + safe);
			return { text: fillCaptionParam(filled, caption), mode: 'infobox' };
		}
		// 2b. Infobox present but with no image field → add image + caption
		// parameters inside it (just before its closing braces).
		var ib = findInfobox(text);
		if (ib && !/\|[ \t]*(?:image|ചിത്രം)[ \t]*=/i.test(text.slice(ib.start, ib.end))) {
			var pre = text.charAt(ib.end - 1) === '\n' ? '' : '\n';
			var params = pre + '| image = ' + fileName + '\n| caption = ' + (caption || '') + '\n';
			return { text: text.slice(0, ib.end) + params + text.slice(ib.end), mode: 'infobox' };
		}
		// 3. Lead thumbnail after any leading maintenance templates / comments.
		var wikilink = '[[പ്രമാണം:' + fileName + '|ലഘുചിത്രം' +
			(caption ? '|' + caption : '') + ']]';
		var pos = findInsertLine(text);
		var lines = text.split('\n');
		lines.splice(pos, 0, wikilink);
		return { text: lines.join('\n'), mode: 'lead' };
	}

	// Does a template name behave like an infobox (accepts image=/caption=)?
	// Covers plain infoboxes plus the taxonomy/chemistry/etc. "*box" families
	// (e.g. Taxobox, Speciesbox), which don't contain the word "infobox".
	function isInfoboxName(name) {
		return /infobox|taxobox|speciesbox|subspeciesbox|hybridbox|drugbox|chembox|geobox|starbox|elementbox/i.test(name) ||
			/വിവരപ്പെട്ടി/.test(name);
	}

	// Locate the first infobox-like template. Returns { start, end } where end
	// is the index of its closing "}}" (brace-matched, so nested {{...}} inside
	// parameter values are handled). Returns null if none is found.
	function findInfobox(text) {
		var re = /\{\{[ \t]*([^|}\n]+)/g;
		var m;
		while ((m = re.exec(text))) {
			if (!isInfoboxName(m[1].trim())) { continue; }
			var depth = 0;
			for (var j = m.index; j < text.length - 1; j++) {
				if (text.charAt(j) === '{' && text.charAt(j + 1) === '{') { depth++; j++; }
				else if (text.charAt(j) === '}' && text.charAt(j + 1) === '}') {
					depth--; j++;
					if (depth === 0) { return { start: m.index, end: j - 1 }; }
				}
			}
		}
		return null;
	}

	// Match a bare filename allowing space/underscore and case variation.
	function bareFileRegex(name) {
		var esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[ _]/g, '[ _]');
		return new RegExp(esc, 'i');
	}

	// Fill an infobox caption= parameter only if it is currently empty.
	function fillCaptionParam(text, caption) {
		if (!caption) { return text; }
		var re = /(\|[ \t]*(?:caption|അടിക്കുറിപ്പ്)[ \t]*=)[ \t]*(?=\r?\n|\||\})/i;
		if (re.test(text)) {
			return text.replace(re, '$1 ' + caption.replace(/\$/g, '$$$$'));
		}
		return text;
	}

	// First line that is prose: skip blank lines, HTML comments and
	// top-of-page templates (tracking multi-line {{...}} nesting depth).
	function findInsertLine(text) {
		var lines = text.split('\n');
		var depth = 0;
		var inComment = false;
		for (var i = 0; i < lines.length; i++) {
			var line = lines[i];
			var isPlain = !inComment && depth === 0 &&
				line.trim() !== '' &&
				!/^\s*(\{\{|<!--|__)/.test(line);
			if (isPlain) { return i; }
			depth += (line.match(/\{\{/g) || []).length;
			depth -= (line.match(/\}\}/g) || []).length;
			if (depth < 0) { depth = 0; }
			if (/<!--/.test(line) && !/-->/.test(line.split('<!--').pop())) { inComment = true; }
			if (inComment && /-->/.test(line)) { inComment = false; }
		}
		return 0;
	}

	// ---------- Malayalam transliteration (Mozhi-style, self-contained) ----------

	// Convert a Latin string to Malayalam. Longest-match syllable model: a
	// consonant carries inherent 'a'; a following vowel swaps in its matra, a
	// following consonant inserts a virama (conjunct), a trailing consonant
	// gets a virama. Word-final cleanups add chillu forms and the anusvaram.
	function mlTranslit(input) {
		var VIND = {
			'au': 'ഔ', 'ou': 'ഔ', 'ai': 'ഐ', 'aa': 'ആ', 'A': 'ആ', 'ee': 'ഈ',
			'ii': 'ഈ', 'I': 'ഈ', 'oo': 'ഊ', 'uu': 'ഊ', 'U': 'ഊ', 'E': 'ഏ',
			'O': 'ഓ', 'a': 'അ', 'i': 'ഇ', 'u': 'ഉ', 'e': 'എ', 'o': 'ഒ'
		};
		var VSIGN = {
			'au': 'ൌ', 'ou': 'ൌ', 'ai': 'ൈ', 'aa': 'ാ', 'A': 'ാ', 'ee': 'ീ',
			'ii': 'ീ', 'I': 'ീ', 'oo': 'ൂ', 'uu': 'ൂ', 'U': 'ൂ', 'E': 'േ',
			'O': 'ോ', 'a': '', 'i': 'ി', 'u': 'ു', 'e': 'െ', 'o': 'ൊ'
		};
		var CONS = {
			'zh': 'ഴ', 'ng': 'ങ', 'nj': 'ഞ', 'kh': 'ഖ', 'gh': 'ഘ', 'chh': 'ഛ',
			'Ch': 'ഛ', 'ch': 'ച', 'jh': 'ഝ', 'Th': 'ഠ', 'Dh': 'ഢ', 'thh': 'ഥ',
			'tt': 'ട്ട', 'th': 'ത', 'dh': 'ധ', 'Sh': 'ഷ', 'sh': 'ശ', 'ph': 'ഫ', 'bh': 'ഭ',
			'k': 'ക', 'g': 'ഗ', 'c': 'ച', 'j': 'ജ', 'T': 'ട', 'D': 'ഡ', 'N': 'ണ',
			't': 'റ്റ', 'd': 'ദ', 'n': 'ന', 'p': 'പ', 'f': 'ഫ', 'b': 'ബ', 'm': 'മ',
			'y': 'യ', 'r': 'ര', 'R': 'റ', 'l': 'ല', 'L': 'ള', 'v': 'വ', 'w': 'വ',
			'S': 'ശ', 's': 'സ', 'h': 'ഹ'
		};
		var VKEYS = Object.keys(VIND).sort(function (a, b) { return b.length - a.length; });
		var CKEYS = Object.keys(CONS).sort(function (a, b) { return b.length - a.length; });
		function match(keys, at) {
			for (var k = 0; k < keys.length; k++) {
				if (input.substr(at, keys[k].length) === keys[k]) { return keys[k]; }
			}
			return null;
		}
		var out = '';
		var pending = false;
		var i = 0;
		while (i < input.length) {
			var c = match(CKEYS, i);
			if (c) {
				if (pending) { out += '്'; }
				out += CONS[c];
				pending = true;
				i += c.length;
				continue;
			}
			var v = match(VKEYS, i);
			if (v) {
				out += pending ? VSIGN[v] : VIND[v];
				pending = false;
				i += v.length;
				continue;
			}
			if (pending) { out += '്'; pending = false; }
			out += input.charAt(i);
			i += 1;
		}
		if (pending) { out += '്'; }
		// A "t" (റ്റ) right after ന collapses to the ന്റ conjunct: enTe → എന്റെ.
		out = out.replace(/ന്റ്റ/g, 'ന്റ');
		var b = '(?=\\s|$|[-,.;:!?)\\]"’])';
		return out
			.replace(new RegExp('മ്' + b, 'g'), 'ം')
			.replace(new RegExp('ന്' + b, 'g'), 'ൻ')
			.replace(new RegExp('ണ്' + b, 'g'), 'ൺ')
			.replace(new RegExp('ര്' + b, 'g'), 'ർ')
			.replace(new RegExp('ല്' + b, 'g'), 'ൽ')
			.replace(new RegExp('ള്' + b, 'g'), 'ൾ');
	}

	// Wire a caption input to the transliterator, toggled by its button.
	// While on, Latin keystrokes are transliterated live; existing text is
	// kept as a prefix so a prefilled English caption can be edited away.
	function attachTransliteration($input, $toggle) {
		var on = false;
		var latin = '';
		var prefix = '';
		function render() { $input.val(prefix + mlTranslit(latin)); }
		$toggle.on('click', function (e) {
			e.preventDefault();
			on = !on;
			latin = '';
			prefix = on ? $input.val() : '';
			$toggle.toggleClass('imgsug-xlit-on', on).text(on ? 'അ' : 'A')
				.attr('title', on ? 'ലിപ്യന്തരണം ഓണ്‍ (ക്ലിക്ക് ചെയ്ത് ഓഫ്)' : 'മലയാളം ലിപ്യന്തരണം ഓണാക്കുക (ഇംഗ്ലീഷിൽ ടൈപ്പ് ചെയ്യുക)');
			$input.focus();
		});
		$input.on('keydown', function (e) {
			if (!on || e.ctrlKey || e.metaKey || e.altKey) { return; }
			if (e.key === 'Backspace') {
				e.preventDefault();
				if (latin.length) { latin = latin.slice(0, -1); }
				else { prefix = prefix.slice(0, -1); }
				render();
			} else if (e.key && e.key.length === 1) {
				e.preventDefault();
				latin += e.key;
				render();
			}
		});
	}

	function addStyles() {
		mw.util.addCSS(
			'#imgsug-fab{position:fixed;bottom:24px;right:24px;z-index:1000;' +
			'background:#36c;color:#fff;border:0;border-radius:24px;padding:10px 18px;' +
			'font-size:14px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3);}' +
			'#imgsug-fab:hover{background:#2a4b8d;}' +
			'.imgsug-panel-base{position:fixed;top:80px;right:24px;width:560px;max-width:95vw;' +
			'max-height:75vh;display:flex;flex-direction:column;z-index:1001;' +
			'background:#fff;border:1px solid #a2a9b1;border-radius:6px;' +
			'box-shadow:0 4px 16px rgba(0,0,0,.25);font-size:13px;}' +
			'#imgsug-finder{bottom:24px;left:24px;top:auto;right:auto;}' +
			'.imgsug-form{display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid #eaecf0;' +
			'flex-wrap:wrap;}' +
			'.imgsug-form select,.imgsug-form input{padding:3px 6px;border:1px solid #a2a9b1;' +
			'border-radius:3px;}' +
			'.imgsug-form input{flex:1;min-width:120px;}' +
			'.imgsug-status{padding:6px 0;color:#54595d;}' +
			'.imgsug-row{display:flex;gap:10px;align-items:center;padding:8px 0;' +
			'border-bottom:1px solid #eaecf0;text-decoration:none;color:inherit;}' +
			'.imgsug-row:hover{background:#f8f9fa;}' +
			'.imgsug-row img{width:60px;height:45px;object-fit:cover;border-radius:3px;' +
			'border:1px solid #c8ccd1;background:#f8f9fa;flex-shrink:0;}' +
			'.imgsug-more{margin:8px 12px;}' +
			'.imgsug-head{display:flex;justify-content:space-between;align-items:center;' +
			'padding:10px 12px;font-weight:bold;border-bottom:1px solid #eaecf0;}' +
			'.imgsug-head span{flex:1;text-align:center;}' +
			'.imgsug-back{text-decoration:none;color:#36c;font-size:16px;font-weight:bold;}' +
			'.imgsug-close{text-decoration:none;color:#54595d;font-size:15px;}' +
			'.imgsug-sub{padding:6px 12px;color:#54595d;border-bottom:1px solid #eaecf0;}' +
			'.imgsug-body{overflow-y:auto;padding:8px 12px;}' +
			'.imgsug-card{display:flex;gap:10px;padding:10px 0;border-bottom:1px solid #eaecf0;}' +
			'.imgsug-card img{width:120px;height:90px;object-fit:cover;border-radius:4px;' +
			'border:1px solid #c8ccd1;background:#f8f9fa;}' +
			'.imgsug-meta{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;}' +
			'.imgsug-name{word-break:break-all;font-weight:bold;}' +
			'.imgsug-lead{background:#fc3;border-radius:3px;padding:0 5px;margin-right:5px;' +
			'font-size:11px;font-weight:normal;}' +
			'.imgsug-license{color:#54595d;font-size:11px;}' +
			'.imgsug-meta input{width:100%;box-sizing:border-box;padding:3px 6px;' +
			'border:1px solid #a2a9b1;border-radius:3px;}' +
			'.imgsug-caprow{display:flex;gap:4px;align-items:stretch;}' +
			'.imgsug-caprow input{flex:1;min-width:0;}' +
			'.imgsug-xlit{flex:0 0 auto;width:28px;border:1px solid #a2a9b1;' +
			'border-radius:3px;background:#f8f9fa;cursor:pointer;font-weight:bold;' +
			'color:#54595d;}' +
			'.imgsug-xlit-on{background:#36c;color:#fff;border-color:#36c;}' +
			'.imgsug-insert{align-self:flex-start;background:#36c;color:#fff;border:0;' +
			'border-radius:3px;padding:4px 12px;cursor:pointer;}' +
			'.imgsug-insert:hover{background:#2a4b8d;}' +
			'.imgsug-insert:disabled{background:#a2a9b1;cursor:default;}'
		);
	}

	mw.loader.using(['mediawiki.api', 'mediawiki.ForeignApi', 'mediawiki.util'], init);
}());
