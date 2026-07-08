/*
 * Copyright Con Kolivas 2026
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation; either version 3 of the License, or (at your option)
 * any later version.  See COPYING for more details.
 */

#include <stdarg.h>
#include <jansson.h>
#include "libckpool.h"
#include "yyjson.h"

/* yyjson custom allocator using ckalloc */
static void *ck_yyjson_malloc(void *ctx, size_t size)
{
	(void)ctx;
	return ckalloc(size);
}

static void *ck_yyjson_realloc(void *ctx, void *ptr, size_t old_size, size_t size)
{
	(void)ctx;
	(void)old_size;   /* ckpool's ckrealloc doesn't need the old size */
	return ckrealloc(ptr, size);
}

static void ck_yyjson_free(void *ctx, void *ptr)
{
	(void)ctx;
	free(ptr);
}

const yyjson_alc ckyyalc = {
	.malloc  = ck_yyjson_malloc,
	.realloc = ck_yyjson_realloc,
	.free    = ck_yyjson_free,
	.ctx     = NULL
};

static void yyjson_mut_pack_skip(const char **pp)
{
	const char *p = *pp;

	while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r' || *p == ',' || *p == ':')
		p++;

	*pp = p;
}

static yyjson_mut_val *yyjson_mut_pack_value(yyjson_mut_doc *doc,
					     const char **pp,
					     va_list *ap)
{
	yyjson_mut_pack_skip(pp);
	const char *p = *pp;

	if (*p == '\0')
		return NULL;

	char c = *p++;
	yyjson_mut_val *val = NULL;

	switch (c) {
	case 's':
		{
			const char *str = va_arg(*ap, const char *);
			if (!str)
				return NULL;
			val = yyjson_mut_strcpy(doc, str);
			break;
		}
	case 'n':
		val = yyjson_mut_null(doc);
		break;
	case 'b':
		{
			int b = va_arg(*ap, int);
			val = yyjson_mut_bool(doc, b != 0);
			break;
		}
	case 'i':
		{
			int i = va_arg(*ap, int);
			val = yyjson_mut_int(doc, i);
			break;
		}
	case 'I':
		{
			int64_t i = va_arg(*ap, int64_t);
			val = yyjson_mut_int(doc, i);
			break;
		}
	case 'f':
	case 'F':
		{
			double d = va_arg(*ap, double);
			val = yyjson_mut_real(doc, d);
			break;
		}
	case 'o':
		{
			val = va_arg(*ap, yyjson_mut_val *);
			if (!val)
				return NULL;
			break;
		}
	case '[':
		{
			val = yyjson_mut_arr(doc);
			if (!val)
				return NULL;

			for (;;) {
				yyjson_mut_pack_skip(&p);
				if (*p == ']') {
					p++;
					break;
				}
				yyjson_mut_val *item = yyjson_mut_pack_value(doc, &p, ap);
				if (!item || !yyjson_mut_arr_append(val, item))
					return NULL;
			}
			break;
		}
	case '{':
		{
			val = yyjson_mut_obj(doc);
			if (!val)
				return NULL;

			for (;;) {
				yyjson_mut_pack_skip(&p);
				if (*p == '}') {
					p++;
					break;
				}
				if (*p != 's')
					return NULL;
				p++; /* consume 's' */

				const char *key = va_arg(*ap, const char *);
				if (!key)
					return NULL;

				yyjson_mut_val *key_val = yyjson_mut_strcpy(doc, key);
				if (!key_val)
					return NULL;

				yyjson_mut_val *item_val = yyjson_mut_pack_value(doc, &p, ap);
				if (!item_val || !yyjson_mut_obj_add(val, key_val, item_val))
					return NULL;
			}
			break;
		}
	default:
		return NULL;
	}

	*pp = p;
	return val;
}

/* Emulates the simpler functionality of libjansson's json_pack */
yyjson_mut_doc *yyjson_mut_pack(const char *fmt, ...)
{
	if (!fmt || !*fmt)
		return NULL;

	yyjson_mut_doc *doc = yyjson_mut_doc_new(&ckyyalc);
	if (!doc)
		return NULL;

	va_list ap;
	va_start(ap, fmt);

	const char *p = fmt;
	yyjson_mut_val *root = yyjson_mut_pack_value(doc, &p, &ap);

	va_end(ap);

	if (!root) {
		yyjson_mut_doc_free(doc);
		return NULL;
	}

	yyjson_mut_pack_skip(&p);
	if (*p != '\0') {
		yyjson_mut_doc_free(doc);
		return NULL;
	}

	yyjson_mut_doc_set_root(doc, root);
	return doc;
}

yyjson_mut_val *yyjson_mut_pack_val(yyjson_mut_doc *doc, const char *fmt, ...)
{
	if (!doc || !fmt || !*fmt)
		return NULL;

	va_list ap;
	va_start(ap, fmt);

	const char *p = fmt;
	yyjson_mut_val *val = yyjson_mut_pack_value(doc, &p, &ap);

	va_end(ap);

	if (!val)
		return NULL;

	yyjson_mut_pack_skip(&p);
	if (*p != '\0')
		return NULL;

	return val;
}

/* Braindead incredibly inefficient conversion to from jansson/yyjson. */
yyjson_mut_doc *json_to_yyjson(json_t *json)
{
	char *s = json_dumps(json, JSON_NO_UTF8);
	yyjson_mut_doc *mut_doc;
	yyjson_doc *doc;

	doc = yyjson_read(s, strlen(s), 0);
	free(s);
	mut_doc = yyjson_doc_mut_copy(doc, &ckyyalc);
	yyjson_doc_free(doc);
	return mut_doc;
}

json_t *yyjson_to_json(yyjson_mut_doc *doc)
{
	char *s = yyjson_mut_write(doc, 0, NULL);
	json_t *json;

	json = json_loads(s, 0, NULL);
	free(s);
	return json;
}
