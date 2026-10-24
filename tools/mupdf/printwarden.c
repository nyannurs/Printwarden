// Printwarden's additions to MuPDF's WebAssembly glue (platform/wasm/lib/mupdf.c): appended to
// that file by tools/mupdf/build.sh, so they share its context (`ctx`, static there), its macros
// (EXPORT, TRY, POINTER, INTEGER, VOID) and wasm_rethrow. Each function: EXPORT on a line of its
// own, the signature on one line (MuPDF's tools/make-wasm-type.js reads them so).
//
// What the stock glue lacks for a print proof (see tools/mupdf/README.md): a page's separations
// (its spot colours) and pixmaps made with them, which is also what makes MuPDF's draw device
// honour overprint; and a page drawn for a press: plain CMYK content read as the chosen CMYK
// profile, so an ink pixmap in that profile keeps plain CMYK exact and converts RGB content
// through it, as Acrobat's Output Preview does.
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

// The separation's name (owned by the set: copy it before the set is dropped).
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

// Component `component` of separation `idx` at full tint, in colorspace `cs` (0..1).
EXPORT
float wasm_pw_separation_equivalent(fz_separations *seps, int idx, fz_colorspace *cs, int component)
{
	float color[FZ_MAX_COLORS] = { 0 };
	TRY({ fz_separation_equivalent(ctx, seps, idx, cs, color, NULL, fz_default_color_params); })
	return color[component];
}

// --- A page drawn for a press ---

// A device passing everything to a draw device, except the default colour spaces: the PDF
// interpreter sets them from the document for every page, and again for every form XObject with
// colour spaces of its own (DeviceCMYK as its own, or as the output intent's profile); each time,
// this device makes DeviceCMYK (and the output intent, which it replaces) read as `press`. A
// page's own DefaultCMYK (an ICC profile of its resources) is kept: that content is converted
// from its profile, as colour management would.
typedef struct
{
	fz_device super;
	fz_colorspace *press;
} pw_press_device;

static void
pw_press_set_default_colorspaces(fz_context *ctx, fz_device *dev_, fz_default_colorspaces *dcs)
{
	pw_press_device *dev = (pw_press_device *)dev_;
	fz_default_colorspaces *press = fz_clone_default_colorspaces(ctx, dcs);
	fz_try(ctx)
	{
		fz_colorspace *cmyk = fz_default_cmyk(ctx, press);
		if (cmyk == fz_device_cmyk(ctx) || cmyk == fz_default_output_intent(ctx, press))
			fz_set_default_cmyk(ctx, press, dev->press);
		fz_set_default_output_intent(ctx, press, dev->press);
		fz_set_default_colorspaces(ctx, dev->super.passthrough, press);
	}
	fz_always(ctx)
		fz_drop_default_colorspaces(ctx, press);
	fz_catch(ctx)
		fz_rethrow(ctx);
}

static void
pw_press_drop_device(fz_context *ctx, fz_device *dev_)
{
	pw_press_device *dev = (pw_press_device *)dev_;
	fz_drop_colorspace(ctx, dev->press);
	fz_drop_device(ctx, dev->super.passthrough);
}

static fz_device *
pw_new_press_device(fz_context *ctx, fz_device *target, fz_colorspace *press)
{
	fz_default_colorspaces *dcs = NULL;
	pw_press_device *dev = fz_new_derived_passthrough_device(ctx, target, pw_press_device);
	dev->press = fz_keep_colorspace(ctx, press);
	dev->super.set_default_colorspaces = pw_press_set_default_colorspaces;
	dev->super.drop_device = pw_press_drop_device;
	fz_var(dcs);
	fz_try(ctx)
	{
		// The same for content drawn before (or without) the interpreter's defaults.
		dcs = fz_new_default_colorspaces(ctx);
		fz_set_default_colorspaces(ctx, &dev->super, dcs);
	}
	fz_always(ctx)
		fz_drop_default_colorspaces(ctx, dcs);
	fz_catch(ctx)
	{
		fz_drop_device(ctx, &dev->super);
		fz_rethrow(ctx);
	}
	return &dev->super;
}

// A page drawn into a new pixmap: over `bbox` (device space, after `ctm`), in `colorspace`, with
// `seps` (NULL: none, as the stock glue draws; an empty set or the page's: overprint honoured,
// each separation as its behaviour says), cleared to paper (opaque, with `alpha` an alpha channel
// too), the page run (contents, annotations and widgets, as the stock glue draws a page) for the
// press `press` (a CMYK colour space: what plain CMYK means; NULL: DeviceCMYK, MuPDF's own). An
// ink pixmap in `press` itself takes plain CMYK as it is, and everything else converted into it.
EXPORT
fz_pixmap * wasm_pw_new_pixmap_from_page(fz_page *page, fz_matrix *ctm, fz_rect *bbox, fz_colorspace *colorspace, fz_separations *seps, boolean alpha, fz_colorspace *press)
{
	fz_pixmap *pix = NULL;
	fz_device *draw = NULL;
	fz_device *dev = NULL;
	fz_var(pix);
	fz_var(draw);
	fz_var(dev);
	fz_try(ctx)
	{
		pix = fz_new_pixmap_with_bbox(ctx, colorspace, fz_irect_from_rect(*bbox), seps, alpha);
		fz_clear_pixmap_with_value(ctx, pix, 0xFF);
		draw = fz_new_draw_device(ctx, fz_identity, pix);
		dev = pw_new_press_device(ctx, draw, press ? press : fz_device_cmyk(ctx));
		fz_run_page(ctx, page, dev, *ctm, NULL);
		fz_close_device(ctx, dev);
	}
	fz_always(ctx)
	{
		fz_drop_device(ctx, dev);
		fz_drop_device(ctx, draw);
	}
	fz_catch(ctx)
	{
		fz_drop_pixmap(ctx, pix);
		wasm_rethrow(ctx);
	}
	return pix;
}
