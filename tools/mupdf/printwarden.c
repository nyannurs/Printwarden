// Printwarden's additions to MuPDF's WebAssembly glue (platform/wasm/lib/mupdf.c): appended to
// that file by tools/mupdf/build.sh, so they share its context (`ctx`, static there), its macros
// (EXPORT, TRY, POINTER, INTEGER, NUMBER, VOID) and wasm_rethrow. Each function: EXPORT on a line
// of its own, the signature on one line (MuPDF's tools/make-wasm-type.js reads them so).
//
// What the stock glue lacks for a print proof (see tools/mupdf/README.md): a page's separations
// (its spot colours) and pixmaps made with them, which is also what makes MuPDF's draw device
// honour overprint; the default colour spaces of a draw device (DeviceCMYK content read in the
// chosen CMYK profile, so an ink pixmap in that profile keeps plain CMYK exact and converts RGB
// content through it, as Acrobat's Output Preview does); whether a page uses overprint; a
// document's output intent.
//
// Copyright 2026 Ramin Strauss. Licensed as MuPDF is: GNU Affero General Public License,
// version 3 or later (see the LICENSE of the built package).

// --- Separations (spot colours) ---

// A page's separations: a new reference (drop it), or NULL (a document kind without them).
EXPORT
fz_separations * wasm_pw_page_separations(fz_page *page)
{
	POINTER(fz_page_separations, page)
}

// An empty set: a pixmap made with it is drawn with overprint honoured, spot colours composited.
EXPORT
fz_separations * wasm_pw_new_separations(void)
{
	POINTER(fz_new_separations, 0)
}

EXPORT
void wasm_pw_drop_separations(fz_separations *seps)
{
	VOID(fz_drop_separations, seps)
}

EXPORT
int wasm_pw_count_separations(fz_separations *seps)
{
	INTEGER(fz_count_separations, seps)
}

EXPORT
char * wasm_pw_separation_name(fz_separations *seps, int idx)
{
	POINTER(fz_separation_name, seps, idx)
}

// behavior: 0 composite (into the process colours), 1 spot (a channel of its own), 2 disabled.
EXPORT
void wasm_pw_set_separation_behavior(fz_separations *seps, int idx, int behavior)
{
	VOID(fz_set_separation_behavior, seps, idx, (fz_separation_behavior)behavior)
}

EXPORT
int wasm_pw_separation_behavior(fz_separations *seps, int idx)
{
	INTEGER(fz_separation_current_behavior, seps, idx)
}

// Component `component` of separation `idx` at full tint, in colorspace `cs` (0..1).
EXPORT
float wasm_pw_separation_equivalent(fz_separations *seps, int idx, fz_colorspace *cs, int component)
{
	float color[FZ_MAX_COLORS] = { 0 };
	TRY({ fz_separation_equivalent(ctx, seps, idx, cs, color, NULL, fz_default_color_params); })
	return color[component];
}

// --- Pixmaps with separations, default colour spaces ---

// A pixmap over `bbox` (device space) in `colorspace`, with `seps` (NULL: none, as the stock
// glue makes them; an empty set or the page's: overprint honoured, each separation set to spot a
// channel of its own after the colorspace's), cleared to paper (or transparent, with alpha).
EXPORT
fz_pixmap * wasm_pw_new_pixmap_with_bbox(fz_colorspace *colorspace, fz_rect *bbox, fz_separations *seps, boolean alpha)
{
	fz_pixmap *pix = NULL;
	fz_var(pix);
	fz_try(ctx)
	{
		pix = fz_new_pixmap_with_bbox(ctx, colorspace, fz_irect_from_rect(*bbox), seps, alpha);
		if (alpha)
			fz_clear_pixmap(ctx, pix);
		else
			fz_clear_pixmap_with_value(ctx, pix, 0xFF);
	}
	fz_catch(ctx)
	{
		fz_drop_pixmap(ctx, pix);
		wasm_rethrow(ctx);
	}
	return pix;
}

// The number of spot channels a pixmap carries (after its colorspace's components).
EXPORT
int wasm_pw_pixmap_spots(fz_pixmap *pix)
{
	return pix->s;
}

// A draw device's default colour spaces: content in DeviceCMYK, DeviceRGB and DeviceGray is read
// as `cmyk`, `rgb` and `gray` (each NULL: unchanged), and `cmyk` is also the output intent, so a
// pixmap in `cmyk` takes plain CMYK as it is, and RGB content converted through that profile.
EXPORT
void wasm_pw_set_default_colorspaces(fz_device *dev, fz_colorspace *cmyk, fz_colorspace *rgb, fz_colorspace *gray)
{
	fz_default_colorspaces *dcs = NULL;
	fz_var(dcs);
	fz_try(ctx)
	{
		dcs = fz_new_default_colorspaces(ctx);
		if (cmyk)
		{
			fz_set_default_cmyk(ctx, dcs, cmyk);
			fz_set_default_output_intent(ctx, dcs, cmyk);
		}
		if (rgb)
			fz_set_default_rgb(ctx, dcs, rgb);
		if (gray)
			fz_set_default_gray(ctx, dcs, gray);
		fz_set_default_colorspaces(ctx, dev, dcs);
	}
	fz_always(ctx)
		fz_drop_default_colorspaces(ctx, dcs);
	fz_catch(ctx)
		wasm_rethrow(ctx);
}

// A page drawn into a new pixmap in one go: the pixmap over `bbox` (device space, after `ctm`)
// in `colorspace` with `seps`, a draw device with the default colour spaces above, the page run
// through it (contents, annotations and widgets, as the stock glue draws a page).
EXPORT
fz_pixmap * wasm_pw_new_pixmap_from_page(fz_page *page, fz_matrix *ctm, fz_rect *bbox, fz_colorspace *colorspace, fz_separations *seps, boolean alpha, fz_colorspace *cmyk, fz_colorspace *rgb, fz_colorspace *gray)
{
	fz_pixmap *pix = NULL;
	fz_device *dev = NULL;
	fz_default_colorspaces *dcs = NULL;
	fz_var(pix);
	fz_var(dev);
	fz_var(dcs);
	fz_try(ctx)
	{
		pix = fz_new_pixmap_with_bbox(ctx, colorspace, fz_irect_from_rect(*bbox), seps, alpha);
		if (alpha)
			fz_clear_pixmap(ctx, pix);
		else
			fz_clear_pixmap_with_value(ctx, pix, 0xFF);
		dev = fz_new_draw_device(ctx, fz_identity, pix);
		if (cmyk || rgb || gray)
		{
			dcs = fz_new_default_colorspaces(ctx);
			if (cmyk)
			{
				fz_set_default_cmyk(ctx, dcs, cmyk);
				fz_set_default_output_intent(ctx, dcs, cmyk);
			}
			if (rgb)
				fz_set_default_rgb(ctx, dcs, rgb);
			if (gray)
				fz_set_default_gray(ctx, dcs, gray);
			fz_set_default_colorspaces(ctx, dev, dcs);
		}
		fz_run_page(ctx, page, dev, *ctm, NULL);
		fz_close_device(ctx, dev);
	}
	fz_always(ctx)
	{
		fz_drop_device(ctx, dev);
		fz_drop_default_colorspaces(ctx, dcs);
	}
	fz_catch(ctx)
	{
		fz_drop_pixmap(ctx, pix);
		wasm_rethrow(ctx);
	}
	return pix;
}

// --- The document and its pages ---

EXPORT
int wasm_pw_page_uses_overprint(fz_page *page)
{
	INTEGER(fz_page_uses_overprint, page)
}

// The document's output intent (PDF/X): a new reference, or NULL.
EXPORT
fz_colorspace * wasm_pw_document_output_intent(fz_document *doc)
{
	fz_colorspace *cs = NULL;
	fz_var(cs);
	fz_try(ctx)
	{
		cs = fz_document_output_intent(ctx, doc);
		if (cs)
			cs = fz_keep_colorspace(ctx, cs);
	}
	fz_catch(ctx)
		wasm_rethrow(ctx);
	return cs;
}
