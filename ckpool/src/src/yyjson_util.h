/*
 * Copyright Con Kolivas 2026
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation; either version 3 of the License, or (at your option)
 * any later version.  See COPYING for more details.
 */

yyjson_mut_doc *yyjson_mut_pack(const char *fmt, ...);
yyjson_mut_val *yyjson_mut_pack_val(yyjson_mut_doc *doc, const char *fmt, ...);
yyjson_mut_doc *json_to_yyjson(json_t *json);
json_t *yyjson_to_json(yyjson_mut_doc *doc);
extern const yyjson_alc ckyyalc;
