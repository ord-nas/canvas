var svg_element = null;
function getIdentityMatrix() {
    return getSVGElement().createSVGMatrix();
}
function getSVGElement() {
    if (svg_element === null) {
        svg_element= document.createElementNS("http://www.w3.org/2000/svg", "svg");
    }
    return svg_element;
}

// Constants.
var bucket_size = 1000 * 5;
var always_clear = false;
var always_reset_transform = false;

// Globals.

var playing = false;
var last_project_time = 0;
var last_real_time = 0;
var current_project_time = 0;
var current_seq_id = 0;
var selection = [];
var global_mouse_action = null;
var last_tick = null;
var viewport_matrix = getIdentityMatrix();
var last_viewport_matrix = null;
var tick_callbacks = {};
var layers = [];
var next_layer_key = 1;
var current_layer = null;
var current_action = null;
var current_project_filepath = null;

function resetGlobals() {
    playing = false;
    last_project_time = 0;
    last_real_time = 0;
    current_project_time = 0;
    current_seq_id = 0;
    selection = [];
    global_mouse_action = null;
    last_tick = null;
    viewport_matrix = getIdentityMatrix();
    last_viewport_matrix = null;
    tick_callbacks = {};
    layers = [];
    next_layer_key = 1;
    current_layer = null;
    current_action = null;
    current_project_filepath = null;
}

function resetState() {
    // Clean up any ongoing action.
    if (current_action) current_action.finish();

    // Reset all global variables.
    resetGlobals();

    // Call update_layers to delete layer artifacts from the DOM.
    update_layers();

    // Ensure that a tool is actually selected.
    $("input[type=radio][name=tool]:checked").change();

    // Reset displayed project time.
    $("#time").val(current_project_time / 1000);
}

function serializeState() {
    // Package up all the global state we need.
    var state = {
        version: "0",
        layers: layers,
        current_seq_id: current_seq_id,
        next_layer_key: next_layer_key,
    };

    // Serialize it.
    return JSON.stringify(state);
}

function deserializeState(state, project_filepath) {
    // Reset everything.
    resetState();

    // Install the new project filepath.
    setProjectFilepath(project_filepath);

    // Run JSON parser.
    var cbs = [];
    var reviver = makeJSONReviver(cbs);
    var deserialized = JSON.parse(state, reviver);

    // Install deserialized globals.
    layers = deserialized.layers;
    current_seq_id = deserialized.current_seq_id;
    next_layer_key = deserialized.next_layer_key;

    // Run reviver callbacks.
    for (var cb of cbs) {
        cb();
    }

    // Run update_layers to update DOM.
    update_layers();
}

function setProjectFilepath(project_filepath) {
    current_project_filepath = project_filepath;
    var txt = current_project_filepath === null ? "(unsaved_project)" : current_project_filepath;
    $("#current_project_name").text(txt);
}

var matrixMaker = {
    translation: function(x, y) {
        var m = getIdentityMatrix();
        m.e = x;
        m.f = y;
        return m;
    },
    scaleAbout: function(origin_x, origin_y, sx, sy) {
        var s = getIdentityMatrix();
        s.a = sx;
        s.d = sy;
        var t = this.translation(origin_x, origin_y);
        var t_inv = this.translation(-origin_x, -origin_y);
        return t.multiply(s).multiply(t_inv);
    },
    rotateAbout: function(origin_x, origin_y, radians) {
        var r = getIdentityMatrix();
        r.a = Math.cos(radians);
        r.b = Math.sin(radians);
        r.c = -r.b;
        r.d = r.a;
        var t = this.translation(origin_x, origin_y);
        var t_inv = this.translation(-origin_x, -origin_y);
        return t.multiply(r).multiply(t_inv);
    },
};

// Based on implementation at: https://stackoverflow.com/questions/7395813/html5-canvas-get-transform-matrix
function addMatrixTrackingToContext(ctx) {
    ctx._matrix = getIdentityMatrix();
    var prior_proto = ctx.__proto__;
    ctx.__proto__ = {
        setMatrix: function(m) {
            this._matrix = m;
            prior_proto.setTransform.call(this, m.a, m.b, m.c, m.d, m.e, m.f);
        },
        transformWithMatrix: function(m) {
            this.setMatrix(m.multiply(this._matrix));
        },
        resetTransform: function() {
            this.setMatrix(getIdentityMatrix());
        },
        __proto__: prior_proto,
    };
}

function invert(m) {
    var inv = getIdentityMatrix();
    inv.a = m.d / (m.a*m.d - m.b*m.c);
    inv.c = -m.c / (m.a*m.d - m.b*m.c);
    inv.e = (m.c*m.f - m.d*m.e) / (m.a*m.d - m.b*m.c);
    inv.b = -m.b / (m.a*m.d - m.b*m.c);
    inv.d = m.a / (m.a*m.d - m.b*m.c);
    inv.f = (m.b*m.e - m.a*m.f) / (m.a*m.d - m.b*m.c);
    return inv;
};

function fake_event_like(event, start, end) {
    var e = Object.create(event);
    e.begin = function() {
        return start;
    }
    e.end = function() {
        return end;
    }
    return e;
}

// Utilities for serialization/deserialization.

function serialize_matrix(m) {
    return {
        a: m.a,
        b: m.b,
        c: m.c,
        d: m.d,
        e: m.e,
        f: m.f,
    };
}

function deserialize_matrix(data) {
    var m = getIdentityMatrix();
    m.a = data.a;
    m.b = data.b;
    m.c = data.c;
    m.d = data.d;
    m.e = data.e;
    m.f = data.f;
    return m;
}

// TODO: Consider making this take a second arg, which is the super method to invoke (if any).
// That way, we don't have to do as much munging inside the returned function.
// Also, we stop relying on the fact that this method is used to set the toJSON property.
function makeJSONEncoder(special_arg_dict) {
    return function(unused = null, current_class = null) {
        // Try calling super. First find the current class if it's unset.
        if (current_class === null) {
            current_class = this.__proto__;
            while (current_class !== null) {
                if (current_class.hasOwnProperty("toJSON")) {
                    break;
                } else {
                    current_class = current_class.__proto__;
                }
            }
            if (current_class === null) {
                throw "Internal error, had trouble walking prototype chain.";
            }
        }

        // Now walk up the chain of parents until we find one that actually defines toJSON.
        var parent = current_class.__proto__;
        while (parent !== null) {
            if (parent.hasOwnProperty("toJSON")) {
                break;
            } else {
                parent = parent.__proto__;
            }
        }

        // If we actually find one, call its toJSON.
        var obj_to_serialize = (parent === null ? this : parent.toJSON.call(this, unused, parent));

        // Now construct the serialized object.
        console.log("Called toJSON on " + current_class.constructor.name);
        var class_name = this.constructor.name;
        var serialize = {
            class_name_for_deserialization: class_name,
        };
        for (var name of Object.getOwnPropertyNames(obj_to_serialize)) {
            if (name === "class_name_for_deserialization") {
                continue;
            }
            if (!this.expected_properties.has(name)) {
                throw class_name + ' has unexpected property: ' + name;
            }
            if (name in special_arg_dict) {
                if (special_arg_dict[name] === null) {
                    continue;
                } else {
                    serialize[name] = special_arg_dict[name](obj_to_serialize[name], obj_to_serialize);
                }
            } else {
                serialize[name] = obj_to_serialize[name];
            }
        }
        return serialize;
    }
}

function makeJSONReviver(callback_vector) {
    return function(key, value) {
        if (value !== null && typeof value === "object" && "class_name_for_deserialization" in value) {
            var class_name = value.class_name_for_deserialization;
            delete value.class_name_for_deserialization;

            var constructor = window[class_name];
            var prototype = window[class_name].prototype;
            var obj = Object.create(prototype);
            for (var name of Object.getOwnPropertyNames(value)) {
                if (!prototype.expected_properties.has(name)) {
                    throw class_name + ' has unexpected property: ' + name;
                }
                obj[name] = value[name];
            }

            if ("reifyFromJSON" in prototype) {
                callback_vector.push(
                    () => (obj.reifyFromJSON())
                );
            }

            return obj;
        } else {
            return value;
        }
    }
}

// START TIMELINE DEFINITION

function Timeline(layer) {
    this.id = "timeline-" + layer.id;
    this.layer = layer;

    this.max_rank = 0;
    this.y_offset = 0;
    this.needs_redraw = true;

    this.window_preview_start = null;
    this.window_preview_end = null;

    this.makeCanvasAndCtx();
}

// Shared timeline stuff
Timeline.start = 0;
Timeline.end = 20 * 1000;
Timeline.thickness = 10;
Timeline.spacing = 20;
Timeline.min_width = 3;
Timeline.max_height = 150;
Timeline.min_height = 30;
Timeline.scale_per_pixel = 0.001;
Timeline.min_time = 100; // ms
Timeline.cursor_width = 1;
Timeline.move_preview_delta = null;
Timeline.duplicate_preview_delta = null;
Timeline.preview_timeline = null;
Timeline.scale_preview_factor = null;
Timeline.scale_preview_anchor = null;
Timeline.scale_preview_stretch = null;
Timeline.min_scale_amount = 0.01;

Timeline.prototype.expected_properties = new Set([
    "id", "layer", "max_rank", "y_offset", "needs_redraw", "window_preview_start", "window_preview_end", "canvas", "ctx",
]);

Timeline.prototype.toJSON = makeJSONEncoder({
    // Properties to discard (need to be created fresh after deserialize).
    canvas: null,
    ctx: null,
    // Properties to discard (need to be reset after deserialize).
    y_offset: null,
    needs_redraw: null,
    window_preview_start: null,
    window_preview_end: null,
    // Properties to transform to a wire-safe format (need to be converted back after deserialize).
    layer: (layer => layer.id),
});


Timeline.prototype.reifyFromJSON = function() {
    // Map these properties back to their proper format.
    this.layer = get_layer_by_id(this.layer);

    // Fill in some properties that should be reset.
    this.y_offset = 0;
    this.needs_redraw = true;
    this.window_preview_start = null;
    this.window_preview_end = null;

    // Rebuild some properties that need to be created fresh.
    this.makeCanvasAndCtx();
}

Timeline.prototype.makeCanvasAndCtx = function() {
    var jCanvas = $('<canvas height="30px" width="1000px"></canvas>');
    jCanvas.attr('id', this.id);
    this.canvas = jCanvas.get(0);
    this.ctx = this.canvas.getContext("2d");
    jCanvas.on("wheel", this.scroll.bind(this));
    jCanvas.on("mousedown", this.mousedown.bind(this));
    jCanvas.on("dblclick", this.dblclick.bind(this));
    jCanvas.on("contextmenu", function(event) {
        event.preventDefault();
    });
}

Timeline.prototype.get_max_y_offset = function() {
    return Math.max(0, (this.max_rank + 1) * Timeline.spacing - this.canvas.height);
}

Timeline.prototype.events_in_time_range = function(start, end) {
    var in_view = new Set();
    var start_bucket = Math.floor(start / bucket_size);
    var end_bucket = Math.floor(end / bucket_size);
    for (var index = start_bucket; index <= end_bucket; ++index) {
        for (var buckets of [this.layer.stroke_buckets,
                             this.layer.transform_buckets,
                             this.layer.visibility_buckets]) {
            if (!(index in buckets)) {
                continue;
            }
            for (var event of buckets[index]) {
                if (event.begin() > end ||
                    event.end() < start) {
                    continue;
                }
                in_view.add(event);
            }
        }
    }

    return in_view;
}

Timeline.prototype.events_in_view = function() {
    return this.events_in_time_range(Timeline.start, Timeline.end);
}

Timeline.prototype.get_hidden_sections = function() {
    var start_bucket = Math.floor(Timeline.start / bucket_size);
    var end_bucket = Math.floor(Timeline.end / bucket_size);

    // First find the state before
    var visible_before = true; // default if we can't find any events
    var index = start_bucket;
    while (index >= 0) {
        if (index in this.layer.visibility_buckets) {
            var latest_event = null;
            for (var event of this.layer.visibility_buckets[index]) {
                if (event.time > Timeline.start) {
                    continue;
                }
                if (latest_event === null || compare_events(event, latest_event) == 1) {
                    latest_event = event;
                }
            }
            if (latest_event !== null) {
                visible_before = latest_event.is_visible();
                break;
            }
        }
        index--;
    }

    // All events in view
    var all_in_view = this.events_in_view();
    // Convert to array, filter to just visibility events, and sort.
    var in_view = Array.from(all_in_view);
    in_view = in_view.filter(function(e) { return (e instanceof VisibilityEvent); });
    in_view = in_view.sort(compare_events);

    // Now compute which segments we're hidden for
    var hidden_segments = [];
    var begin_hidden = (visible_before ? null : Timeline.start);
    for (var event of in_view) {
        var visible = event.is_visible();
        if (!visible && begin_hidden === null) {
            begin_hidden = event.time;
        }
        if (visible && begin_hidden !== null) {
            hidden_segments.push([begin_hidden, event.time]);
            begin_hidden = null;
        }
    }
    if (begin_hidden !== null) {
        hidden_segments.push([begin_hidden, Timeline.end]);
    }

    return hidden_segments;
}

Timeline.prototype.get_rect = function(event) {
    var time_delta = Timeline.end - Timeline.start;
    var space_delta = this.canvas.width;

    var x1 = (event.begin() - Timeline.start) / time_delta * space_delta;
    var x2 = (event.end() - Timeline.start) / time_delta * space_delta;
    var y1 = (event.rank + 0.5) * Timeline.spacing - (Timeline.thickness / 2.0);

    return [x1, y1 - this.y_offset, Math.max(x2-x1, Timeline.min_width), Timeline.thickness];
}

Timeline.prototype.get_colour = function(event) {
    // Preview window selection
    var preview_selection = false;
    if (this.window_preview_start !== null) {
        var [x1, y1, width, height] = this.get_rect(event);
        if (x1 >= this.window_preview_start &&
            x1 + width <= this.window_preview_end) {
            preview_selection = true;
        }
    }

    if (preview_selection || selection.indexOf(event) != -1) {
        // TODO: will need something better here when we start handling selections of
        // parts of events.
        return 'red';
    } else if (event instanceof Stroke) {
        return 'blue';
    } else if (event instanceof Transform) {
        return 'orange';
    } else {
        return 'green';
    }
}

Timeline.prototype.draw = function() {
    var height_required = (this.max_rank + 1) * Timeline.spacing;
    this.canvas.height = Math.min(Timeline.max_height, Math.max(Timeline.min_height, height_required));
    this.y_offset = Math.min(this.y_offset, this.get_max_y_offset());

    // Init colour
    this.ctx.fillStyle = "#9ea2a8";
    this.ctx.beginPath();
    this.ctx.rect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.closePath();
    this.ctx.fill();

    // Draw visibility information
    var hidden_segments = this.get_hidden_sections();
    for (var segment of hidden_segments) {
        var x_begin = (segment[0] - Timeline.start) / (Timeline.end - Timeline.start) * this.canvas.width;
        var x_end = (segment[1] - Timeline.start) / (Timeline.end - Timeline.start) * this.canvas.width;
        this.ctx.fillStyle = 'LightGreen';
        this.ctx.beginPath();
        this.ctx.rect(x_begin, 0, x_end - x_begin, this.canvas.height);
        this.ctx.closePath();
        this.ctx.fill();
    }

    // Draw the windows selection preview
    if (this.window_preview_start !== null) {
        this.ctx.beginPath();
        this.ctx.rect(this.window_preview_start,
                      0,
                      this.window_preview_end - this.window_preview_start,
                      this.canvas.height);
        this.ctx.fillStyle = '#60646b';
        this.ctx.fill();
    }

    // Draw the events. If we are doing a move/scale preview, exclude the selected
    // events.
    var selected_set =  new Set(selection);
    for (var event of this.events_in_view()) {
        // Skip "incomplete" events with no set rank.
        if (event.rank === null) {
            continue;
        }

        // Skip selected events that have been dragged to a new location/scale.
        // We'll draw these below, when we do the previews.
        if (selected_set.has(event) &&
            (Timeline.move_preview_delta !== null ||
             Timeline.scale_preview_factor !== null)) {
            continue;
        }

        var [x1, y1, width, height] = this.get_rect(event);
        this.ctx.beginPath();
        this.ctx.rect(x1, y1, width, height);
        this.ctx.fillStyle = this.get_colour(event);
        this.ctx.fill();
    }

    // Draw the move preview
    if (Timeline.move_preview_delta !== null ||
        Timeline.duplicate_preview_delta !== null) {
        var delta = Timeline.move_preview_delta ||
            Timeline.duplicate_preview_delta;
        var min_rank_in_selection = Number.POSITIVE_INFINITY;
        for (var event of selection) {
            min_rank_in_selection = Math.min(min_rank_in_selection, event.rank);
        }
        for (var event of selection) {
            if (Timeline.preview_timeline === null) {
                if (event.layer !== this.layer) {
                    continue;
                }
            } else {
                if (Timeline.preview_timeline !== this) {
                    continue;
                }
            }
            var moved_event = event.shallow_copy();
            moved_event.start += delta;
            if (event.layer !== this.layer) {
                moved_event.rank -= min_rank_in_selection;
            }
            var [x1, y1, width, height] = this.get_rect(moved_event);

            this.ctx.beginPath();
            this.ctx.rect(x1, y1, width, height);
            this.ctx.fillStyle = 'rgba(255, 0, 0, 0.3)';
            this.ctx.fill();
        }
    }

    // Draw the scale preview
    if (Timeline.scale_preview_factor !== null) {
        for (var event of selection) {
            if (event.layer != this.layer) {
                continue;
            }
            var scaled_start = Timeline.scale_preview_factor * (event.begin() - Timeline.scale_preview_anchor)  + Timeline.scale_preview_anchor;
            var scaled_end = Timeline.scale_preview_stretch ?
                Timeline.scale_preview_factor * (event.end() - Timeline.scale_preview_anchor)  + Timeline.scale_preview_anchor :
                scaled_start + (event.end() - event.begin());
            var scaled_event = fake_event_like(event, scaled_start, scaled_end);
            var [x1, y1, width, height] = this.get_rect(scaled_event);

            this.ctx.beginPath();
            this.ctx.rect(x1, y1, width, height);
            this.ctx.fillStyle = 'rgba(255, 0, 0, 0.3)';
            this.ctx.fill();
        }
    }

    // Draw the cursor
    var x_now = (current_project_time - Timeline.start) / (Timeline.end - Timeline.start) * this.canvas.width;
    this.ctx.beginPath();
    this.ctx.moveTo(x_now, 0);
    this.ctx.lineTo(x_now, this.canvas.height);
    this.ctx.lineWidth = Timeline.cursor_width;
    this.ctx.strokeStyle = 'gold';
    this.ctx.stroke();

    this.needs_redraw = false;
}

Timeline.prototype.scroll = function(event) {
    event.preventDefault();
    if (event.originalEvent.deltaMode != 0) {
        console.log("ERROR: wheel event with non pixel deltaMode");
        return;
    }

    if (!event.ctrlKey && !event.shiftKey) {
        var raw_offset = this.y_offset + event.originalEvent.deltaY;
        this.y_offset = Math.max(0, Math.min(this.get_max_y_offset(), raw_offset));
        this.needs_redraw = true;
    } else if (event.shiftKey) {
        var millis_per_pixel = (Timeline.end - Timeline.start) / this.canvas.width;
        var new_start = Timeline.start + event.originalEvent.deltaY * millis_per_pixel;
        new_start = Math.max(0, new_start);
        var delta = new_start - Timeline.start;
        Timeline.start = new_start;
        Timeline.end += delta;
        for (var layer of layers) {
            layer.timeline.needs_redraw = true;
        }
    } else if (event.ctrlKey) {
        var pos = getMousePos(event, this.canvas);
        var time = pos.x / this.canvas.width * (Timeline.end - Timeline.start) + Timeline.start;
        var scale = 1 + (Timeline.scale_per_pixel * event.originalEvent.deltaY);
        var new_start = time - ((time - Timeline.start) * scale);
        new_start = Math.max(0, new_start);
        var new_end = time + ((Timeline.end - time) * scale);
        if (new_start + Timeline.min_time < new_end) {
            Timeline.start = new_start;
            Timeline.end = new_end;
            for (var layer of layers) {
                layer.timeline.needs_redraw = true;
            }
        }
    }
}

Timeline.prototype.assign_rank = function(event) {
    var taken = [];
    for (var e of this.events_in_time_range(event.begin(), event.end())) {
        if (e.rank !== null) {
            taken[e.rank] = true;
        }
    }
    var rank = 0;
    while (taken[rank]) ++rank;
    event.rank = rank;

    this.max_rank = Math.max(this.max_rank, rank);

    return rank;
}

Timeline.prototype.mouse_pos_to_event = function(pos) {
    for (var event of this.events_in_view()) {
        var [x1, y1, width, height] = this.get_rect(event);
        if (pos.x >= x1 &&
            pos.x <= x1+width &&
            pos.y >= y1 &&
            pos.y <= y1+height) {
            return event;
        }
    }
    return null;
}

function move_event_to_layer(event, layer) {
    if (event.layer === layer) {
        // That was easy!
        return;
    }
    if (event instanceof VisibilityEvent) {
        event.layer = layer;
    } else if (event instanceof Stroke) {
        // We make the (kind of arbitrary) choice that when you move events between layers,
        // you want *now* to "line up". This is kind of arbitrary, but easy to implement,
        // and reasonably flexible (although a litter counter-intuitive at first, because
        // it means that moving an event from one layer to another does different things
        // depending on where the curson is).
        // TODO: also adjust width, once we've straightened that mess out.
        var original_matrix = findTransformMatrix(event.layer);
        var new_matrix = findTransformMatrix(layer);
        var conversion_matrix = invert(new_matrix).multiply(original_matrix);
        event.layer = layer;
        for (var pnt of event.pnts) {
            // TODO: maybe this svg_point thing is too slow ... profile!
            var svg_pnt = getSVGElement().createSVGPoint();
            svg_pnt.x = pnt.x;
            svg_pnt.y = pnt.y;
            svg_pnt = svg_pnt.matrixTransform(conversion_matrix);
            pnt.x = svg_pnt.x;
            pnt.y = svg_pnt.y;
        }
    } else { // event instanceof Transform
        console.log("ERROR: NOT SUPPORTED YET!");
    }
}

function timeline_move_duplicate_preview(evnt, move_action) {
    var pos = getMousePos(evnt, move_action.timeline.canvas);
    var initial_pos = getMousePos(move_action.mousedown_evnt, move_action.timeline.canvas);
    if (pos != initial_pos) {
        move_action.mouse_moved = true;
    }
    if (move_action.mouse_moved) {
        // If we've moved, compute the time delta and set a global Timeline property
        // so all Timelines know they need to show a move preview.
        var current_time = pos.x / move_action.timeline.canvas.width * (Timeline.end - Timeline.start) + Timeline.start;
        var initial_time = initial_pos.x / move_action.timeline.canvas.width * (Timeline.end - Timeline.start) + Timeline.start;
        if (move_action.mousedown_evnt.shiftKey) {
            Timeline.duplicate_preview_delta = current_time - initial_time;
        } else {
            Timeline.move_preview_delta = current_time - initial_time;
        }
        // Check if we need to figure out interlayer moves
        if (move_action.allow_interlayer) {
            if (Timeline.preview_timeline !== null) {
                Timeline.preview_timeline.needs_redraw = true;
            }
            Timeline.preview_timeline = (getTimelineAtMousePos(evnt) ||
                                         Timeline.preview_timeline ||
                                         move_action.timeline);
            if (Timeline.preview_timeline !== null) {
                Timeline.preview_timeline.needs_redraw = true;
            }
        }
        // Invalidate all timelines that have events in the selection, so that they will
        // redraw and show the move preview.
        for (var s of selection) {
            s.layer.timeline.needs_redraw = true;
        }
    }
}

function timeline_move_duplicate() {
    // Check that none of the movements result in a start time < 0, and if so bail
    var can_do_move = true;
    var delta = Timeline.move_preview_delta ||
        Timeline.duplicate_preview_delta;
    for (var e of selection) {
        if (e.start + delta < 0) {
            can_do_move = false;
        }
        // Regardless of whether or not the move succeeds, we need to redraw
        // every timeline in the selection.
        e.layer.timeline.needs_redraw = true;
    }
    if (Timeline.preview_timeline !== null) {
        Timeline.preview_timeline.needs_redraw = true;
    }
    var events_to_add = [];
    if (can_do_move && Timeline.move_preview_delta !== null) {
        remove_events(selection);
        for (var e of selection) {
            e.start += delta;
        }
        events_to_add = selection;
    } else if (can_do_move && Timeline.duplicate_preview_delta !== null) {
        events_to_add = selection.map(function(event) {
            var duplicate = event.clone();
            duplicate.start += delta;
            return duplicate;
        });
    }
    if (Timeline.preview_timeline !== null) {
        for (var event of events_to_add) {
            move_event_to_layer(event, Timeline.preview_timeline.layer);
        }
    }
    add_events(events_to_add);
    Timeline.move_preview_delta = null;
    Timeline.duplicate_preview_delta = null;
    Timeline.preview_timeline = null;
}

function get_deltas(e) {
    if (e instanceof Stroke) {
        return e.pnts;
    } else if (e instanceof Transform) {
        return e.deltas;
    } else if (e instanceof VisibilityEvent) {
        return []; // Nothing to scale!
    } else {
        console.log("ERROR: Tried to scale, but got event in selection of unknown type");
        return null;
    }
}

function scale_deltas(e, amount) {
    var arr = get_deltas(e);
    for (var p of arr) {
        p.time *= amount;
    }
}

function timeline_scale() {
    remove_events(selection);
    for (var e of selection) {
        e.start = Timeline.scale_preview_factor * (e.start - Timeline.scale_preview_anchor)  + Timeline.scale_preview_anchor;
        if (!Timeline.scale_preview_stretch) {
            continue;
        }
        scale_deltas(e, Timeline.scale_preview_factor);
    }
    add_events(selection);
}

function timeline_allow_interlayer(e, timeline) {
    if (!e.altKey) {
        return false;
    }
    for (event of selection) {
        if (event.layer !== timeline.layer) {
            return false;
        }
        if (event instanceof Transform) {
            return false;
        }
    }
    return true;
}

function allow_event_transform() {
    if (selection.length < 1) {
        return false;
    }
    for (var event of selection) {
        if (!(event instanceof Stroke)) {
            return false;
        }
        if (event.layer !== current_layer) {
            return false;
        }
    }
    return true;
}

function get_new_transform_sink(layer) {
    if (allow_event_transform() &&
        $("#transform_events_checkbox").is(":checked")) {
        return new TransformEventSink(layer);
    } else {
        return new TransformLayerSink(layer);
    }
}

function TimelineMoveAction1(evnt, timeline) {
    this.mousedown_evnt = evnt;
    this.timeline = timeline;
    this.mouse_moved = false;
    this.allow_interlayer = timeline_allow_interlayer(evnt, timeline);
}
TimelineMoveAction1.prototype.mousemove = function(evnt) {
    timeline_move_duplicate_preview(evnt, this);
}
TimelineMoveAction1.prototype.mouseup = function(evnt) {
    if (this.mouse_moved) {
        timeline_move_duplicate();
    }
}

function TimelineMoveAction2(evnt, timeline) {
    this.mousedown_evnt = evnt;
    this.timeline = timeline;
    this.mouse_moved = false;
    this.allow_interlayer = timeline_allow_interlayer(evnt, timeline);
}
TimelineMoveAction2.prototype.mousemove = function(evnt) {
    timeline_move_duplicate_preview(evnt, this);
}
TimelineMoveAction2.prototype.mouseup = function(evnt) {
    if (this.mouse_moved) {
        timeline_move_duplicate();
    } else {
        this.timeline.handle_click(this.mousedown_evnt);
    }
}

function TimelineMoveAction3(evnt, timeline) {
    this.mousedown_evnt = evnt;
    this.timeline = timeline;
    this.mouse_moved = false;
}
TimelineMoveAction3.prototype.mousemove = function(evnt) {
    var pos = getMousePos(evnt, this.timeline.canvas);
    var initial_pos = getMousePos(this.mousedown_evnt, this.timeline.canvas);
    if (pos != initial_pos) {
        this.mouse_moved = true;
    }
    if (this.mouse_moved) {
        // If we've moved, compute the time delta and set some properties
        // so that this.timeline knows it needs to show a window selection.
        this.timeline.window_preview_start = Math.min(pos.x, initial_pos.x);
        this.timeline.window_preview_end = Math.max(pos.x, initial_pos.x);
        this.timeline.needs_redraw = true;
    }
}
TimelineMoveAction3.prototype.mouseup = function(evnt) {
    if (this.mouse_moved) {
        this.timeline.handle_window_selection(this.mousedown_evnt);
    } else {
        this.timeline.handle_click(this.mousedown_evnt);
    }
    this.timeline.window_preview_start = null;
    this.timeline.window_preview_end = null;
    this.timeline.needs_redraw = true;
}

function TimelineMoveAction4(anchor_time, evnt, timeline) {
    this.anchor_time = anchor_time;
    this.mousedown_evnt = evnt;
    this.timeline = timeline;
    this.mouse_moved = false;
}
TimelineMoveAction4.prototype.mousemove = function(evnt) {
    var pos = getMousePos(evnt, this.timeline.canvas);
    var time = pos.x / this.timeline.canvas.width * (Timeline.end - Timeline.start) + Timeline.start;
    var initial_pos = getMousePos(this.mousedown_evnt, this.timeline.canvas);
    var initial_time = initial_pos.x / this.timeline.canvas.width * (Timeline.end - Timeline.start) + Timeline.start;
    if (pos != initial_pos) {
        this.mouse_moved = true;
    }
    if (this.mouse_moved) {
        // If we've moved, compute the scale amount and set it as a property on
        // Timeline so that all timelines can do a scale preview.
        Timeline.scale_preview_anchor = this.anchor_time;
        Timeline.scale_preview_factor = (time - this.anchor_time) / (initial_time - this.anchor_time);
        Timeline.scale_preview_factor = Math.max(Timeline.scale_preview_factor, Timeline.min_scale_amount);
        Timeline.scale_preview_stretch = !this.mousedown_evnt.ctrlKey;
        for (var s of selection) {
            s.layer.timeline.needs_redraw = true;
        }
    }
}
TimelineMoveAction4.prototype.mouseup = function(evnt) {
    if (this.mouse_moved) {
        timeline_scale();
    }
    Timeline.scale_preview_factor = null;
    Timeline.scale_preview_anchor = null;
    for (var s of selection) {
        s.layer.timeline.needs_redraw = true;
    }
}

Timeline.prototype.mousedown = function(evnt) {
    if (global_mouse_action) {
        return;
    }
    // CASES:
    // 1. Mousedown on an unselected event:
    //    - Select event
    //    - Mousemove does a move preview, records move
    //    - Release does a move if applicable
    // 2. Mousedown on a selected event:
    //    - Records if ctrl key pressed
    //    - Mousemove does a move preview, records move
    //    - Release does a move if applicable, otherwise a click
    // 3. Mousedown on nothing:
    //    - Records if ctrl key pressed
    //    - Mousemove does a window selection preview, records move
    //    - Release does a windows selection if applicable, otherwise a click
    // 4. Right mousedown:
    //    - Records starting point
    //    - Mousemove does scale preview if applicable, records move
    //    - Release does a scale if applicable

    evnt.stopPropagation();

    // If we are overtop of an unselected event, then do a click right away. We do
    // this so that click-and-drag on an unselected event causes that event to move
    // as you would expect.
    var pos = getMousePos(evnt, this.canvas);
    var selected_event = this.mouse_pos_to_event(pos);

    if (evnt.which == 3) {
        // Case 4 - right click
        if (evnt.ctrlKey) {
            var [min_time, max_time] = this.get_selection_begin_spread();
        } else {
            var [min_time, max_time] = this.get_selection_extremes();
        }
        if (min_time === null) {
            return;
        }
        var pos = getMousePos(evnt, this.canvas);
        var time = pos.x / this.canvas.width * (Timeline.end - Timeline.start) + Timeline.start;
        if (min_time < time && max_time < time) {
            global_mouse_action = new TimelineMoveAction4(min_time, evnt, this);
        } else if (min_time > time && max_time > time) {
            global_mouse_action = new TimelineMoveAction4(max_time, evnt, this);
        }
    } else if (selected_event == null) {
        // Case 3
        global_mouse_action = new TimelineMoveAction3(evnt, this);
    } else if (selection.indexOf(selected_event) == -1) {
        // Case 1
        this.handle_click(evnt);
        global_mouse_action = new TimelineMoveAction1(evnt, this);
    } else {
        // Case 2
        global_mouse_action = new TimelineMoveAction2(evnt, this);
    }
}

Timeline.prototype.get_selection_extremes = function() {
    var min_x = null;
    var max_x = null;
    for (var event of selection) {
        if (min_x === null || event.begin() < min_x) {
            min_x = event.begin()
        }
        if (max_x === null || event.end() > max_x) {
            max_x = event.end();
        }
    }
    return [min_x, max_x];
}

Timeline.prototype.get_selection_begin_spread = function() {
    var min_x = null;
    var max_x = null;
    for (var event of selection) {
        if (min_x === null || event.begin() < min_x) {
            min_x = event.begin()
        }
        if (max_x === null || event.begin() > max_x) {
            max_x = event.begin();
        }
    }
    return [min_x, max_x];
}

Timeline.prototype.handle_click = function(mousedown_evnt) {
    var pos = getMousePos(mousedown_evnt, this.canvas);
    var selected_event = this.mouse_pos_to_event(pos);
    if (mousedown_evnt.ctrlKey) {
        if (selected_event !== null) {
            var index = selection.indexOf(selected_event);
            if (index === -1) {
                selection.push(selected_event);
            } else {
                selection.splice(index, 1);
            }
            this.needs_redraw = true;
        }
    } else {
        for (var s of selection) {
            s.layer.timeline.needs_redraw = true;
        }
        this.needs_redraw = true;
        if (selected_event !== null) {
            selection = [selected_event];
        } else {
            selection = [];
        }
    }
}

Timeline.prototype.handle_window_selection = function(mousedown_evnt) {
    if (this.window_preview_start === null || this.window_preview_end === null) {
        console.log("ERROR: trying to do window selection, but got bad bounds");
        return;
    }

    if (!mousedown_evnt.ctrlKey) {
        for (var s of selection) {
            s.layer.timeline.needs_redraw = true;
        }
        selection = [];
    }
    for (var event of this.events_in_view()) {
        var [x1, y1, width, height] = this.get_rect(event);
        if (x1 >= this.window_preview_start &&
            x1 + width <= this.window_preview_end) {
            var index = selection.indexOf(event);
            if (index === -1) {
                selection.push(event);
                this.needs_redraw = true;
            }
        }
    }
}

Timeline.prototype.dblclick = function(event) {
    if (!playing) {
        var pos = getMousePos(event, this.canvas);
        var time = pos.x / this.canvas.width * (Timeline.end - Timeline.start) + Timeline.start;
        last_project_time = time;
        set_current_project_time();
        $("#time").val(current_project_time / 1000);
    }
}

Timeline.prototype.recompute_max_rank = function() {
    var accumulate_max_rank = function(acc, value) {
        if (value.rank !== null && value.rank > acc) {
            return value.rank;
        }
        return acc;
    };
    this.max_rank = Math.max(this.layer.strokes.reduce(accumulate_max_rank, 0),
                             this.layer.transforms.reduce(accumulate_max_rank, 0),
                             this.layer.visibility_events.reduce(accumulate_max_rank, 0));
}

// END TIMELINE DEFINITION

// START LAYER DEFINITION

function Layer(title, id, background_image_url = null) {
    this.id = "layer-" + id;
    this.title = title;
    this.handle_id = "layerhandle_" + id;
    this.matrices = [getIdentityMatrix()];
    this.visibilities = [true];
    this.child_index = null;
    this.ancestors = [this];
    this.children = [];

    this.timeline = new Timeline(this);

    this.last_draw = null;
    this.last_transform = null;
    this.last_visibility_check = null;
    this.redraw_on_transform_change = true;

    this.stroke_buckets = {};
    this.strokes = [];
    this.transform_buckets = {};
    this.transforms = [];
    this.visibility_buckets = {};
    this.visibility_events = [];

    this.parent = null;

    this.background_image = null;
    if (background_image_url !== null) {
        this.background_image = new Image;
        this.background_image.src = background_image_url;
    }

    this.last_viewport_matrix = getIdentityMatrix();

    this.makeCanvasAndCtx();
}

Layer.prototype.expected_properties = new Set([
    "id", "canvas", "title", "handle_id", "ctx", "matrices", "visibilities", "child_index", "ancestors", "children", "timeline", "last_draw",
    "last_transform", "last_visibility_check", "redraw_on_transform_change", "temp_canvas", "stroke_buckets", "strokes", "transform_buckets",
    "transforms", "visibility_buckets", "visibility_events", "parent", "background_image", "last_viewport_matrix",
]);

Layer.prototype.toJSON = makeJSONEncoder({
    // Properties to discard (need to be created fresh after deserialize).
    canvas: null,
    ctx: null,
    temp_canvas: null,
    stroke_buckets: null,
    transform_buckets: null,
    visibility_buckets: null,
    // Properties to discard (need to be reset after deserialize).
    last_viewport_matrix: null,
    last_draw: null,
    last_transform: null,
    last_visibility_check: null,
    redraw_on_transform_change: null,
    // Properties to transform to a wire-safe format (need to be converted back after deserialize).
    matrices: (m => m.map(serialize_matrix)),
    background_image: (image => image === null ? null : image.src),
    ancestors: (a => a.map(layer => layer.id)),
    children: (c => c.map(layer => layer.id)),
    parent: (p => p === null ? null : p.id),
});

Layer.prototype.reifyFromJSON = function() {
    // Map these properties back to their proper format.
    this.matrices = this.matrices.map(deserialize_matrix);
    if (this.background_image !== null) {
        var src = this.background_image;
        this.background_image = new Image;
        this.background_image.src = src;
    }
    this.ancestors = this.ancestors.map(get_layer_by_id);
    this.children = this.children.map(get_layer_by_id);
    if (this.parent !== null) {
        this.parent = get_layer_by_id(this.parent);
    }

    // Fill in some properties that should be reset.
    this.last_viewport_matrix = getIdentityMatrix();
    this.last_draw = null;
    this.last_transform = null;
    this.last_visibility_check = null;
    this.redraw_on_transform_change = true;

    // Rebuild some properties that need to be created fresh.
    this.buildBuckets();
    this.makeCanvasAndCtx();
}

Layer.prototype.makeCanvasAndCtx = function() {
    var jCanvas = $('<canvas height="720px" width="1280px" style="position:absolute;left:0px;top:0px"></canvas>');
    jCanvas.attr('id', this.id);
    this.canvas = jCanvas.get(0);
    this.ctx = this.canvas.getContext("2d");
    addMatrixTrackingToContext(this.ctx);
    this.temp_canvas = null;
}

Layer.prototype.buildBuckets = function() {
    this.stroke_buckets = {};
    for (var stroke of this.strokes) {
        addToAllRelevantBuckets(stroke, this.stroke_buckets);
    }
    this.transform_buckets = {};
    for (var transform of this.transforms) {
        addToAllRelevantBuckets(transform, this.transform_buckets);
    }
    this.visibility_buckets = {};
    for (var visibility_event of this.visibility_events) {
        addToAllRelevantBuckets(visibility_event, this.visibility_buckets);
    }
}

Layer.prototype.resetTransform = function() {
    for (var i = 0; i < this.matrices.length; ++i) {
        this.matrices[i] = getIdentityMatrix();
    }
    this.ctx.resetTransform();
}

Layer.prototype.resetVisibility = function() {
    for (var i = 0; i < this.visibilities.length; ++i) {
        this.visibilities[i] = true;
    }
}

Layer.prototype.is_visible = function() {
    return this.visibilities.every(x => x);
}

Layer.prototype.clear_temp_canvas = function() {
    this.temp_canvas = null;
}

Layer.prototype.reset_temp_canvas = function() {
    this.temp_canvas = document.createElement('canvas');
    this.temp_canvas.width = this.canvas.width;
    this.temp_canvas.height = this.canvas.height;
    var ctx = this.temp_canvas.getContext("2d");
    addMatrixTrackingToContext(ctx);
    ctx.drawImage(this.canvas, 0, 0);
    ctx.setMatrix(this.ctx._matrix);
}

Layer.prototype.get_temp_canvas = function() {
    if (this.temp_canvas === null) {
        this.reset_temp_canvas();
    }
    return this.temp_canvas;
}

Layer.prototype.finalize_event = function(event) {
    this.timeline.assign_rank(event);
    // Update timeline to reflect new event
    this.timeline.needs_redraw = true;
}

// END LAYER DEFINITION

// Don't call this directly. Call remove_events, and pass an array of one event.
function remove_event_impl(event, buckets, arr) {
    var index = arr.indexOf(event);
    if (index == -1) {
        console.log("ERROR: Trying to delete event, but can't find it in arr!");
        return;
    }
    arr.splice(index, 1);
    var start_bucket = Math.floor(event.begin() / bucket_size);
    var end_bucket = Math.floor(event.end() / bucket_size);
    for (var bucket = start_bucket; bucket <= end_bucket; bucket++) {
        if (!(bucket in buckets)) {
            console.log("ERROR: Trying to delete event, but missing bucket!");
            return;
        }
        var index = buckets[bucket].indexOf(event);
        if (index == -1) {
            console.log("ERROR: Trying to delete event, but can't find it in bucket!");
        }
        buckets[bucket].splice(index, 1);
    }

}

function remove_events(events) {
    var timelines_touched = new Set();
    for (var e of events) {
        if (e instanceof Stroke) {
            remove_event_impl(e, e.layer.stroke_buckets, e.layer.strokes);
            e.layer.last_draw = null;
        } else if (e instanceof Transform) {
            remove_event_impl(e, e.layer.transform_buckets, e.layer.transforms);
            for (var layer of get_layer_descendants(e.layer)) {
                layer.last_transform = null;
            }
        } else if (e instanceof VisibilityEvent) {
            remove_event_impl(e, e.layer.visibility_buckets, e.layer.visibility_events);
            for (var layer of get_layer_descendants(e.layer)) {
                layer.last_visibility_check = null;
            }
        } else {
            console.log("ERROR: Trying to remove unrecognized event type");
            return;
        }
        timelines_touched.add(e.layer.timeline);
    }
    for (var timeline of timelines_touched) {
        timeline.recompute_max_rank();
        timeline.needs_redraw = true;
    }
}

// Don't call this directly. Call add_events, and pass an array of one event.
function add_event_impl(event, buckets, arr) {
    arr.push(event);
    var start_bucket = Math.floor(event.begin() / bucket_size);
    var end_bucket = Math.floor(event.end() / bucket_size);
    for (var bucket = start_bucket; bucket <= end_bucket; bucket++) {
        addToBucket(buckets, bucket, event);
    }
    event.rank = null;
    event.layer.finalize_event(event);
}

function add_events(events) {
    for (var e of events) {
        if (e instanceof Stroke) {
            add_event_impl(e, e.layer.stroke_buckets, e.layer.strokes);
            e.layer.last_draw = null;
        } else if (e instanceof Transform) {
            add_event_impl(e, e.layer.transform_buckets, e.layer.transforms);
            for (var layer of get_layer_descendants(e.layer)) {
                layer.last_transform = null;
            }
        } else if (e instanceof VisibilityEvent) {
            add_event_impl(e, e.layer.visibility_buckets, e.layer.visibility_events);
            for (var layer of get_layer_descendants(e.layer)) {
                layer.last_visibility_check = null;
            }
        } else {
            console.log("ERROR: Trying to add unrecognized event type");
            return;
        }
        e.layer.timeline.needs_redraw = true;
    }
}

function addToBucket(buckets, index, item) {
    if (!(index in buckets)) {
        buckets[index] = [];
    }
    buckets[index].push(item);
}

function addToAllRelevantBuckets(event, buckets) {
    var start_bucket = Math.floor(event.begin() / bucket_size);
    var end_bucket = Math.floor(event.end() / bucket_size);
    for (var bucket = start_bucket; bucket <= end_bucket; bucket++) {
        addToBucket(buckets, bucket, event);
    }
}

function getMousePos(evt, canvas) {
    if (canvas === undefined) {
        canvas = document.getElementById("tool-overlay");
    }
    var rect = canvas.getBoundingClientRect();
    return {
        x: evt.clientX - rect.left - parseInt($(canvas).css("border-left-width")),
        y: evt.clientY - rect.top - parseInt($(canvas).css("border-top-width")),
    };
}

function getTimelineAtMousePos(evt) {
    for (layer of layers) {
        var canvas = layer.timeline.canvas;
        var pos = getMousePos(evt, canvas);
        if (pos.x >= 0 && pos.y >= 0 && pos.x < canvas.width && pos.y < canvas.height) {
            return layer.timeline;
        }
    }
    return null;
}

function findTransformedPoint(pnt, layer) {
    var svg_pnt = getSVGElement().createSVGPoint();
    svg_pnt.x = pnt.x;
    svg_pnt.y = pnt.y;
    return svg_pnt.matrixTransform(invert(findTransformMatrix(layer)));
}

function findTransformMatrix(layer) {
    // TODO: It's annoying (and really bad) that we have to do this ...
    var old_m = layer.ctx._matrix;
    var old_matrices = layer.matrices.slice(); // Copy
    var now = {
        time: current_project_time,
        seq_id: current_seq_id,
    };
    transformPeriod(layer.last_transform, now, layer);
    var retval = layer.ctx._matrix;
    layer.ctx.setMatrix(old_m);
    layer.matrices = old_matrices;
    // END ANNOYING
    return retval;
}

function clear(layer, draw_background = true) {
    var ctx = layer.ctx;
    var m = ctx._matrix;
    ctx.resetTransform();
    ctx.clearRect(0, 0, 1280, 720);
    ctx.setMatrix(m);
    if (draw_background && layer.background_image !== null) {
        ctx.drawImage(layer.background_image, 0, 0);
    }
}

function compare_events(a, b) {
    if (a.time < b.time) {
        return -1;
    } else if (a.time > b.time) {
        return 1;
    } else if (a.seq_id < b.seq_id) {
        return -1;
    } else if (a.seq_id > b.seq_id) {
        return 1;
    } else {
        return 0;
    }
}

function extract_events(bucket) {
    var all_events = [];
    for (var i = 0; i < bucket.length; i++) {
        bucket[i].push_events_into(all_events);
    }
    all_events.sort(compare_events);
    return all_events;
}

function evalPeriod(start, end, buckets, args) {
    var i, j, bucket;
    var performed_action = false;
    if (typeof start == "number") {
        start = {
            time: start,
            seq_id: 0,
        };
    }
    if (typeof end == "number") {
        end = {
            time: end,
            seq_id: Infinity,
        };
    }
    var start_bucket = Math.floor(start.time / bucket_size);
    var end_bucket = Math.floor(end.time / bucket_size);
    for (bucket = start_bucket; bucket <= end_bucket; bucket++) {
        if (!(bucket in buckets)) {
            continue;
        }
        var events = extract_events(buckets[bucket]);
        for (var i = 0; i < events.length; i++) {
            var event = events[i];
            if (event.time >= bucket * bucket_size &&
                event.time < (bucket+1) * bucket_size &&
                compare_events(event, start) >= 0 &&
                compare_events(event, end) <= 0) {
                event.eval(args);
                performed_action = true;
            }
        }
    }
    return performed_action;
}

function updateVisibilityForPeriod(start, end, layer, visibilities) {
    if (visibilities === undefined) {
        visibilities = layer.visibilities;
    }
    var current_layer = layer;
    var performed_action = false;
    var child_index = null;
    for (var i = 0; i < visibilities.length; ++i) {
        var args = [child_index, visibilities[i]];
        performed_action = evalPeriod(start, end, current_layer.visibility_buckets, args) || performed_action;
        visibilities[i] = args[1];
        child_index = current_layer.child_index;
        current_layer = current_layer.parent;
    }
    return performed_action;
}

function drawPeriod(start, end, layer, ctx) {
    if (ctx === undefined) {
        ctx = layer.ctx;
    }
    return evalPeriod(start, end, layer.stroke_buckets, [ctx]);
}

function transformPeriod(start, end, layer, ctx, matrices) {
    if (ctx === undefined) {
        ctx = layer.ctx;
    }
    if (matrices === undefined) {
        matrices = layer.matrices;
    }
    var current_layer = layer;
    var performed_action = false;
    for (var i = 0; i < matrices.length; ++i) {
        // TODO this is ugly, but we hold on to the args list because when we
        // multiply matrices we get a new matrix, so if we want to actually get
        // out the value that we compute at the end of this, we put it into a
        // list so that we can set the list element to be the new matrix.
        var args = [matrices[i]];
        performed_action = evalPeriod(start, end, current_layer.transform_buckets, args) || performed_action;
        matrices[i] = args[0];
        current_layer = current_layer.parent;
    }
    var total_matrix = getIdentityMatrix();
    for (var matrix of matrices) {
        total_matrix = matrix.multiply(total_matrix);
    }
    ctx.setMatrix(total_matrix);
    ctx.transformWithMatrix(viewport_matrix);
    //return evalPeriod(start, end, layer.transform_buckets, [ctx]);
    return performed_action;
}

function tick() {
    set_current_project_time();
    var changed = (last_tick === null || last_tick != current_project_time);
    // TODO: prevent bad stuff, like deleting the last layer while a tool is in use!
    if (current_action && current_layer) {
        current_action.tick();
    }
    for (var i = 0; i < layers.length; i++) {
        draw(layers[i]);
        if (playing || changed || layers[i].timeline.needs_redraw) {
            // We need "playing or changed" instead of just "changed", because in the case
            // of mouse moves in the canvas area, the mouse move will update the current
            // project time, and apparently that happens at about the same time as this
            // tick, because in that case our call to set_project_time will see no difference,
            // so we will see changed === false. That will cause us not to update when we
            // should.
            layers[i].timeline.draw();
        }
    }
    if (playing) {
        // TODO: should I just make this part of set_current_project_time?
        $("#time").val(current_project_time / 1000);
    }
    // Update state of transform checkbox
    if (allow_event_transform()) {
        $("#transform_events_checkbox").parent().removeClass("strikethrough");
        $("#transform_events_checkbox").prop("disabled", false);
    } else {
        $("#transform_events_checkbox").parent().addClass("strikethrough");
        $("#transform_events_checkbox").prop("disabled", true);
    }
    // Update viewport indicator
    if (!matrix_equals(viewport_matrix, last_viewport_matrix)) {
        draw_viewport();
        last_viewport_matrix = matrix_clone(viewport_matrix);
    }
    if (!matrix_equals(viewport_matrix, getIdentityMatrix())) {
        $("#viewport-overlay").addClass('altered_viewport');
        $("#viewport_state_description").text("Viewport moved!");
        $("#reset_viewport").css("visibility", "visible");
    } else {
        $("#viewport-overlay").removeClass('altered_viewport');
        $("#viewport_state_description").text("Viewport is set to default.");
        $("#reset_viewport").css("visibility", "hidden");
    }
    last_tick = current_project_time;
    for (var key in tick_callbacks) {
        var cb = tick_callbacks[key];
        cb();
    }
    window.requestAnimationFrame(tick);
}

function draw_viewport() {
    var canvas = $("#viewport-overlay").get(0);
    var ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, 1280, 720);
    if (!matrix_equals(viewport_matrix, getIdentityMatrix())) {
        var m = viewport_matrix;
        ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
        ctx.beginPath();
        ctx.rect(0, 0, 1280, 720);
        ctx.stroke();
        ctx.resetTransform();
    }
}

function update_layer_ancestors(layer) {
    var new_ancestors = get_layer_ancestors(layer);
    var new_child_index = (layer.parent === null ?
                           null :
                           layer.parent.children.findIndex(function(child) {
                               return child === layer;
                           }));
    if (!shallow_array_equals(new_ancestors, layer.ancestors)) {
        console.log("LAYER ANCESTORS CHANGED: " + layer.title);
        layer.last_transform = null;
        layer.last_visibility_check = null;
        layer.ancestors = new_ancestors;
        layer.child_index = new_child_index;
        layer.matrices = [];
        layer.visibilities = [];
        for (var i = 0; i < new_ancestors.length; ++i) {
            layer.matrices.push(getIdentityMatrix());
            layer.visibilities.push(true);
        }
    } else if (new_child_index !== layer.child_index) {
        console.log("LAYER CHILD INDEX CHANGED: " + layer.title);
        layer.last_visibility_check = null;
        layer.child_index = new_child_index;
        layer.visibilities = [];
        for (var i = 0; i < new_ancestors.length; ++i) {
            layer.visibilities.push(true);
        }
    }
}

function standard_draw(layer) {
    // Check if our layer ancestors have changed since last draw
    update_layer_ancestors(layer);
    var now = {
        time: current_project_time,
        seq_id: current_seq_id,
    };
    if (layer.last_visibility_check === null ||
        compare_events(now, layer.last_visibility_check) < 0) {
        console.log("RESET VISIBILITY (STANDARD)");
        layer.resetVisibility();
        updateVisibilityForPeriod(0, now, layer);
    } else {
        updateVisibilityForPeriod(layer.last_visibility_check, now, layer);
    }
    layer.last_visibility_check = now;
    if (!layer.is_visible()) {
        // We are going to break out early!
        $(layer.canvas).css("visibility", "hidden");
        return;
    }
    $(layer.canvas).css("visibility", "visible");
    var transform_changed = false;
    if (always_reset_transform ||
        layer.last_transform === null ||
        compare_events(now, layer.last_transform) < 0) {
        console.log("RESET TRANSFORM (STANDARD)");
        layer.resetTransform();
        transformPeriod(0, now, layer);
        transform_changed = true;
    } else  {
        transform_changed = transformPeriod(layer.last_transform, now, layer);
    }
    if (!matrix_equals(viewport_matrix, layer.last_viewport_matrix)) {
        transform_changed = true;
    }
    if (always_clear ||
        layer.last_draw === null ||
        compare_events(now, layer.last_draw) < 0 ||
        transform_changed) {
        console.log("CLEAR (STANDARD)");
        clear(layer);
        drawPeriod(0, now, layer);
    } else {
        drawPeriod(layer.last_draw, now, layer);
    }
    layer.last_draw = now;
    layer.last_transform = now;
    layer.last_viewport_matrix = matrix_clone(viewport_matrix);
    // Do this just to leave layer.temp_canvas in a state that
    // post_transform_draw expects.
    layer.clear_temp_canvas();
}

function post_transform_draw(layer) {
    // Check if our layer ancestors have changed since last draw
    update_layer_ancestors(layer);
    var now = {
        time: current_project_time,
        seq_id: current_seq_id,
    };
    if (layer.last_visibility_check === null ||
        compare_events(now, layer.last_visibility_check) < 0) {
        console.log("RESET VISIBILITY (STANDARD)");
        layer.resetVisibility();
        updateVisibilityForPeriod(0, now, layer);
    } else {
        updateVisibilityForPeriod(layer.last_visibility_check, now, layer);
    }
    layer.last_visibility_check = now;
    if (!layer.is_visible()) {
        // We are going to break out early!
        $(layer.canvas).css("visibility", "hidden");
        return;
    }
    $(layer.canvas).css("visibility", "visible");
    var temp_canvas = layer.get_temp_canvas();
    var temp_ctx = temp_canvas.getContext("2d");
    if (layer.last_draw === null || compare_events(now, layer.last_draw) < 0 ||
        layer.last_transform === null || compare_events(now, layer.last_transform) < 0) {
        console.log("RESET TRANSFORM & DRAW (POST)");
        layer.resetTransform();
        transformPeriod(0, now, layer);
        console.log("CLEAR (POST)");
        clear(layer);
        drawPeriod(0, now, layer);
        layer.reset_temp_canvas();
        layer.last_transform = now;
    } else {
        drawPeriod(layer.last_draw, now, layer, temp_ctx);
        var old_m = layer.ctx._matrix;
        var old_matrices = layer.matrices.slice(); // copy
        transformPeriod(layer.last_transform, now, layer);
        var delta = layer.ctx._matrix.multiply(invert(old_m));
        clear(layer, /*draw_background=*/false);
        layer.ctx.setMatrix(delta);
        layer.ctx.drawImage(temp_canvas, 0, 0);
        // Do this just to leave layer.ctx's matrix in a state that
        // standard_draw expects.
        layer.ctx.setMatrix(old_m);
        layer.matrices = old_matrices;
    }
    layer.last_draw = now;
}

function draw(layer) {
    if (layer.redraw_on_transform_change) {
        standard_draw(layer);
    } else {
        post_transform_draw(layer);
    }
}

// LineMaker
function LineMaker(top_left, top_right, bottom_right, start_time, end_time, colour, width, layer) {
    this.x_axis = {
        x: top_right.x - top_left.x,
        y: top_right.y - top_left.y,
    };
    this.y_axis = {
        x: bottom_right.x - top_right.x,
        y: bottom_right.y - top_right.y,
    };
    this.origin = top_left;
    this.start_time = start_time;
    this.dt = end_time - start_time;
    this.colour = colour;
    this.width = width;
    this.layer = layer;
    this.seq_id_base = Math.min(top_left.seq_id, top_right.seq_id, bottom_right.seq_id);
    this.seq_id_delta = Math.max(top_left.seq_id, top_right.seq_id, bottom_right.seq_id) - this.seq_id_base;
    this.seq_id_offset = 0;
}

LineMaker.max_seq_ids = 10000;

LineMaker.prototype.make_line = function(start, end) {
    var [sx, sy, st] = start;
    var [ex, ey, et] = end;
    var sid = this.seq_id_offset++ * this.seq_id_delta / LineMaker.max_seq_ids + this.seq_id_base;
    var eid = this.seq_id_offset++ * this.seq_id_delta / LineMaker.max_seq_ids + this.seq_id_base;
    // TODO: more elegant way of handling this.
    if (this.seq_id_offset > LineMaker.max_seq_ids) {
        console.log("ERROR: Too many lines for one LineMaker!");
        return null;
    }
    return new Line({x: this.origin.x + sx * this.x_axis.x + sy * this.y_axis.x,
                     y: this.origin.y + sx * this.x_axis.y + sy * this.y_axis.y,
                     seq_id: sid},
                    {x: this.origin.x + ex * this.x_axis.x + ey * this.y_axis.x,
                     y: this.origin.y + ex * this.x_axis.y + ey * this.y_axis.y,
                     seq_id: eid},
                    this.start_time + st * this.dt,
                    this.start_time + et * this.dt,
                    this.colour,
                    this.width,
                    this.layer);
}

function set_current_project_time() {
    current_project_time = last_project_time;
    if (playing) {
        var now = new Date();
        var delta = now.getTime() - last_real_time;
        current_project_time += delta;
    }
}

// Copied from fontpicker.
function font_spec_to_components(fontSpec) {
    var tmp = fontSpec.split(':'),
        family = tmp[0],
        variant = tmp[1] || '400',
        italic = false, weight = 400;

    if (/(\d+)i$/.test(variant)) {
        italic = true;
        weight = RegExp.$1;
    }
    else {
        weight = variant;
    }

    return {
        family: family,
        weight: weight,
        italic: italic
    }
}

function get_current_colour() {
    return $("#stroke_colour").val();
}

function get_current_width() {
    return $("#stroke_width").slider("value");
}

function get_current_table_rows() {
    var value = parseInt($("#table_rows_txt").val());
    if (isNaN(value)) {
        return 1;
    } else {
        return Math.max(1, value);
    }
}

function get_current_table_cols() {
    var value = parseInt($("#table_cols_txt").val());
    if (isNaN(value)) {
        return 1;
    } else {
        return Math.max(1, value);
    }
}

function get_current_text_size() {
    var value = parseInt($("#font_size").val());
    if (isNaN(value)) {
        return 24;
    } else {
        return Math.max(1, value);
    }
}

function get_current_text_alignment() {
    var vlookup = {top: -1, middle: 0, bottom: 1};
    var hlookup = {left: -1, centre: 0, right: 1};
    var selection = $('input[name=text-alignment-radio]:checked').attr("id");
    if (selection === undefined) {
        return [-1, -1];
    }
    var alignments = selection.split("-");
    return [vlookup[alignments[0]], hlookup[alignments[1]]];
}

function get_current_text_style() {
    var selector = $("#font_selector").get(0);
    var spec = (selector === undefined ? "Arial:400" : selector.value);
    return font_spec_to_components(spec);
}

function draw_tmp_object(obj) {
    var ctx = document.getElementById("tool-overlay").getContext("2d");
    ctx.clearRect(0, 0, 1280, 720);

    if (obj !== null) {
        var events = [];
        obj.push_events_into(events);
        events.sort(compare_events);
        for (var event of events) {
            event.eval([ctx]);
        }
    }
}

function set_obj_layer(obj, layer) {
    obj.layer = layer;

    for (var pnt of obj.pnts) {
        var new_pnt = findTransformedPoint(pnt, layer);
        pnt.x = new_pnt.x;
        pnt.y = new_pnt.y;
    }

    layer.strokes.push(obj);
    var start_bucket = Math.floor(obj.begin() / bucket_size);
    var end_bucket = Math.floor(obj.end() / bucket_size);
    for (var b = start_bucket; b <= end_bucket; ++b) {
        addToBucket(current_layer.stroke_buckets, b, obj);
    }

    layer.finalize_event(obj);
    layer.last_draw = null;
}

// STROKE EVENT

function StrokeEvent(start, end, time, seq_id, colour, width) {
    this.start = start;
    this.end = end;
    this.time = time;
    this.seq_id = seq_id;
    this.colour = colour;
    this.width = width;
}

StrokeEvent.prototype.eval = function(args) {
    var ctx = args[0];
    var previous_composite_operation = ctx.globalCompositeOperation;
    ctx.beginPath();
    ctx.moveTo(this.start.x, this.start.y);
    ctx.lineTo(this.end.x, this.end.y);
    ctx.lineWidth = this.width;
    ctx.lineCap = 'round';
    if (this.colour == "eraser") {
        ctx.globalCompositeOperation="destination-out";
    } else {
        ctx.strokeStyle = this.colour;
    }
    ctx.stroke();
    ctx.globalCompositeOperation = previous_composite_operation;
}

// ARC EVENT

function ArcEvent(centre, x_axis, y_axis, hradius, vradius, start_angle, end_angle, time, seq_id, colour, width) {
    this.centre = centre;
    this.x_axis = x_axis;
    this.y_axis = y_axis;
    this.hradius = hradius;
    this.vradius = vradius;
    this.start_angle = start_angle;
    this.end_angle = end_angle;
    this.time = time;
    this.seq_id = seq_id;
    this.colour = colour;
    this.width = width;
}

ArcEvent.prototype.eval = function(args) {
    var ctx = args[0];
    var old_m = ctx._matrix;
    var axis_matrix = getIdentityMatrix();
    axis_matrix.a = this.x_axis.x - this.centre.x;
    axis_matrix.b = this.x_axis.y - this.centre.y;
    axis_matrix.c = this.y_axis.x - this.centre.x;
    axis_matrix.d = this.y_axis.y - this.centre.y;
    axis_matrix.e = this.centre.x;
    axis_matrix.f = this.centre.y;
    ctx.setMatrix(old_m.multiply(axis_matrix));
    ctx.beginPath();
    ctx.ellipse(0,
                0,
                this.hradius,
                this.vradius,
                0,
                this.start_angle,
                this.end_angle,
                /*counter-clockwise=*/false
               );
    ctx.lineWidth = this.width;
    ctx.strokeStyle = this.colour;
    ctx.stroke();
    ctx.setMatrix(old_m);
}

// TEXT EVENT

function TextEvent(centre, x_axis, y_axis, x_pos, y_pos, text, time, seq_id, colour, font) {
    this.centre = centre;
    this.x_axis = x_axis;
    this.y_axis = y_axis;
    this.x_pos = x_pos;
    this.y_pos = y_pos;
    this.text = text;
    this.time = time;
    this.seq_id = seq_id;
    this.colour = colour;
    this.font = font;
}

TextEvent.prototype.eval = function(args) {
    var ctx = args[0];
    var old_m = ctx._matrix;
    var axis_matrix = getIdentityMatrix();
    axis_matrix.a = this.x_axis.x - this.centre.x;
    axis_matrix.b = this.x_axis.y - this.centre.y;
    axis_matrix.c = this.y_axis.x - this.centre.x;
    axis_matrix.d = this.y_axis.y - this.centre.y;
    axis_matrix.e = this.centre.x;
    axis_matrix.f = this.centre.y;
    ctx.setMatrix(old_m.multiply(axis_matrix));
    ctx.font = this.font;
    ctx.fillStyle = this.colour;
    ctx.fillText(this.text, this.x_pos, this.y_pos);
    ctx.setMatrix(old_m);
}

// STROKE

function Stroke(start, colour, width, layer) {
    this.start = start;
    this.colour = colour;
    this.width = width;
    this.pnts = [];
    this.layer = layer;
    this.rank = null;
}

Stroke.prototype.expected_properties = new Set([
    "start", "colour", "width", "pnts", "layer", "rank",
]);

Stroke.prototype.toJSON = makeJSONEncoder({
    // Properties to transform to a wire-safe format (need to be converted back after deserialize).
    layer: (layer => layer.id),
});

Stroke.prototype.reifyFromJSON = function() {
    // Map these properties back to their proper format.
    this.layer = get_layer_by_id(this.layer);
}

Stroke.prototype.push_events_into = function(arr) {
    var j;
    for (j = 1; j < this.pnts.length; j++) {
        arr.push(new StrokeEvent(this.pnts[j-1],
                                 this.pnts[j],
                                 this.start + this.pnts[j].time,
                                 this.pnts[j].seq_id,
                                 this.colour,
                                 this.width)
                );
    }
}

Stroke.prototype.begin = function() {
    return this.start;
}

Stroke.prototype.end = function() {
    if (this.pnts.length > 0) {
        return this.start + this.pnts[this.pnts.length-1].time;
    } else {
        return this.start;
    }
}

Stroke.prototype.shallow_copy = function() {
    var cpy = Object.create(this.__proto__);
    Object.assign(cpy, this);
    return cpy;
}

Stroke.prototype.clone = function() {
    var duplicate = Object.create(this.__proto__);
    Object.assign(duplicate, this);
    duplicate.pnts = this.pnts.map(function(pnt) {
        var duplicate_pnt = Object.assign({}, pnt);
        duplicate_pnt.seq_id = current_seq_id++;
        return duplicate_pnt;
    });
    return duplicate;
}

Stroke.prototype.reverse = function() {
    var old_times = this.pnts.map(function (p) { return p.time; });
    var last = old_times[old_times.length-1];
    var old_seq_ids = this.pnts.map(function (p) { return p.seq_id; });
    this.pnts.reverse();
    for (var i = 0; i < this.pnts.length; i++) {
        this.pnts[i].time = last - old_times[this.pnts.length-i-1];
        this.pnts[i].seq_id = old_seq_ids[i];
    }
}

// Line

function Line(start_pnt, end_pnt, start_time, end_time, colour, width, layer) {
    Stroke.call(this, start_time, colour, width, layer);
    this.pnts = [{x: start_pnt.x,
                  y: start_pnt.y,
                  time: 0,
                  seq_id: start_pnt.seq_id},
                 {x: end_pnt.x,
                  y: end_pnt.y,
                  time: end_time - start_time,
                  seq_id: end_pnt.seq_id}];
}
Line.prototype = Object.create(Stroke.prototype);
Line.prototype.constructor = Line;

Line.prototype.push_events_into = function(arr) {
    var num_divisions = 50; // arbitrary
    var dx = this.pnts[1].x - this.pnts[0].x;
    var dy = this.pnts[1].y - this.pnts[0].y;
    var dt = this.pnts[1].time - this.pnts[0].time;
    for (var i = 0; i < num_divisions; i++) {
        var start = {
            x: this.pnts[0].x + (dx * i / num_divisions),
            y: this.pnts[0].y + (dy * i / num_divisions),
        };
        var j = i + 1;
        var end = {
            x: this.pnts[0].x + (dx * j / num_divisions),
            y: this.pnts[0].y + (dy * j / num_divisions),
        };
        var time = this.start + this.pnts[0].time + (dt * i / (num_divisions-1));
        var seq_id = this.pnts[0].seq_id + (i / num_divisions);
        arr.push(new StrokeEvent(start,
                                 end,
                                 time,
                                 seq_id,
                                 this.colour,
                                 this.width)
                );
    }
}

// Ellipse

function Ellipse(centre, x_axis, y_axis, hradius, vradius, start_time, end_time, colour, width, layer) {
    Stroke.call(this, start_time, colour, width, layer);
    this.pnts = [{x: centre.x,
                  y: centre.y,
                  time: 0,
                  seq_id: centre.seq_id},
                 {x: x_axis.x,
                  y: x_axis.y,
                  time: 0,
                  seq_id: x_axis.seq_id},
                 {x: y_axis.x,
                  y: y_axis.y,
                  time: end_time - start_time,
                  seq_id: y_axis.seq_id}];
    this.hradius = hradius;
    this.vradius = vradius;
}
Ellipse.prototype = Object.create(Stroke.prototype);
Ellipse.prototype.constructor = Ellipse;

Ellipse.prototype.expected_properties = new Set([
    "start", "colour", "width", "pnts", "layer", "rank", "hradius", "vradius",
]);

Ellipse.prototype.push_events_into = function(arr) {
    var num_divisions = 50; // arbitrary
    var dt = this.pnts[2].time - this.pnts[0].time;
    for (var i = 0; i < num_divisions; i++) {
        var time = this.start + this.pnts[0].time + (dt * i / (num_divisions-1));
        var seq_id = this.pnts[0].seq_id + (i / num_divisions);
        arr.push(new ArcEvent(this.pnts[0],
                              this.pnts[1],
                              this.pnts[2],
                              this.hradius,
                              this.vradius,
                              i / num_divisions * 2 * Math.PI,
                              (i+1) / num_divisions * 2 * Math.PI,
                              time,
                              seq_id,
                              this.colour,
                              this.width)
                );
    }
}

// TODO Implement reverse for ellipse.
// Possibly other objects too where the default implementation doesn't work.

// ObjectCollection

function ObjectCollection(start_time, color, width, layer) {
    Stroke.call(this, start_time, color, width, layer);
    this.reversed = false;

    this.cached_objs = [];
    this.cached_start = null;
    this.cached_pnts = [];
    this.cached_reversed = false;
}
ObjectCollection.prototype = Object.create(Stroke.prototype);
ObjectCollection.prototype.constructor = ObjectCollection;

ObjectCollection.prototype.expected_properties = new Set([
    "start", "colour", "width", "pnts", "layer", "rank", "reversed", "cached_objs", "cached_start", "cached_pnts", "cached_reversed",
]);

ObjectCollection.prototype.toJSON = makeJSONEncoder({
    // Properties to discard (need to be reset after deserialize).
    cached_objs: null,
    cached_start: null,
    cached_pnts: null,
    cached_reversed: null,
});

ObjectCollection.prototype.reifyFromJSON = function() {
    Stroke.prototype.reifyFromJSON.call(this);
    // Recreate some properties.
    this.cached_objs = [];
    this.cached_start = null;
    this.cached_pnts = [];
    this.cached_reversed = false;
}

ObjectCollection.prototype.cache_is_fresh = function() {
    var fields = ["x", "y", "time", "seq_id"];
    if (this.start != this.cached_start) return false;
    if (this.reversed != this.cached_reversed) return false;
    if (this.pnts.length != this.cached_pnts.length) return false;
    for (var i = 0; i < this.pnts.length; i++) {
        for (var field of fields) {
            if (this.pnts[i][field] != this.cached_pnts[i][field]) return false;
        }
    }
    return true;
}

ObjectCollection.prototype.update_cache = function() {
    if (this.cache_is_fresh()) {
        return;
    }
    this.cached_start = this.start;
    this.cached_pnts = this.pnts.map(function(pnt) {
        return Object.assign({}, pnt);
    });
    this.cached_objs = this.create_objs();
    this.cached_reversed = this.reversed;
    if (this.reversed) {
        reverse_events(this.cached_objs);
    }
}

ObjectCollection.prototype.push_events_into = function(arr) {
    this.update_cache();
    for (var obj of this.cached_objs) {
        obj.push_events_into(arr);
    }
}

ObjectCollection.prototype.clone = function() {
    var duplicate = Object.create(this.__proto__);
    Object.assign(duplicate, this);
    duplicate.pnts = this.pnts.map(function(pnt) {
        var duplicate_pnt = Object.assign({}, pnt);
        duplicate_pnt.seq_id = current_seq_id++;
        return duplicate_pnt;
    });
    return duplicate;
}

ObjectCollection.prototype.reverse = function() {
    this.reversed = !this.reversed;
}

// Rectangle

function Rectangle(top_left, bottom_right, start_time, end_time, colour, width, layer) {
    ObjectCollection.call(this, start_time, colour, width, layer);
    this.pnts = [{x: top_left.x,
                  y: top_left.y,
                  time: 0,
                  seq_id: top_left.seq_id},
                 {x: bottom_right.x,
                  y: top_left.y,
                  time: 0,
                  seq_id: bottom_right.seq_id},
                 {x: bottom_right.x,
                  y: bottom_right.y,
                  time: end_time - start_time,
                  seq_id: bottom_right.seq_id}];
}
Rectangle.prototype = Object.create(ObjectCollection.prototype);
Rectangle.prototype.constructor = Rectangle;

Rectangle.prototype.create_objs = function() {
    var x_len = distance(this.pnts[0], this.pnts[1]);
    var y_len = distance(this.pnts[1], this.pnts[2]);
    var x_step = 0.5 * x_len / (x_len + y_len);
    var line_maker = new LineMaker(
        this.pnts[0], this.pnts[1], this.pnts[2], this.begin(), this.end(),
        this.colour, this.width, this.layer);
    return [
        line_maker.make_line([0, 0, 0], [1, 0, x_step]),
        line_maker.make_line([1, 0, x_step], [1, 1, 0.5]),
        line_maker.make_line([1, 1, 0.5], [0, 1, 0.5 + x_step]),
        line_maker.make_line([0, 1, 0.5 + x_step], [0, 0, 1]),
    ];
}

// Polygon

function Polygon(pnts, start_time, colour, width, layer, smooth_time=true) {
    if (pnts.length < 2) {
        console.log("ERROR: tried to construct polygon with not enough points");
        console.log(pnts);
    }
    ObjectCollection.call(this, start_time, colour, width, layer);
    this.pnts = pnts;
    this.smooth_time = smooth_time;
}
Polygon.prototype = Object.create(ObjectCollection.prototype);
Polygon.prototype.constructor = Polygon;

Polygon.prototype.expected_properties = new Set([
    "start", "colour", "width", "pnts", "layer", "rank", "reversed", "cached_objs", "cached_start", "cached_pnts", "cached_reversed",
    "smooth_time",
]);

Polygon.prototype.create_objs = function() {
    var partial_len_sums = [0];
    var total_len = 0;
    for (var i = 0; i < this.pnts.length - 1; i++) {
        total_len += distance(this.pnts[i], this.pnts[i+1]);
        partial_len_sums.push(total_len);
    }
    var total_time = this.pnts[this.pnts.length-1].time;
    var objs = [];
    for (var i = 0; i < this.pnts.length - 1; i++) {
        var t1 = this.start + (this.smooth_time ?
                               partial_len_sums[i] / total_len * total_time :
                               this.pnts[i].time);
        var t2 = this.start + (this.smooth_time ?
                               partial_len_sums[i+1] / total_len * total_time :
                               this.pnts[i+1].time);
        objs.push(new Line(this.pnts[i],
                           this.pnts[i+1],
                           t1,
                           t2,
                           this.colour,
                           this.width,
                           this.layer));
    }
    return objs;
}

// Table

function Table(top_left, bottom_right, start_time, end_time, rows, cols, colour, width, layer) {
    ObjectCollection.call(this, start_time, colour, width, layer);
    this.pnts = [{x: top_left.x,
                  y: top_left.y,
                  time: 0,
                  seq_id: top_left.seq_id},
                 {x: bottom_right.x,
                  y: top_left.y,
                  time: 0,
                  seq_id: bottom_right.seq_id},
                 {x: bottom_right.x,
                  y: bottom_right.y,
                  time: end_time - start_time,
                  seq_id: bottom_right.seq_id}];
    this.rows = rows;
    this.cols = cols;
}
Table.prototype = Object.create(ObjectCollection.prototype);
Table.prototype.constructor = Table;

Table.prototype.expected_properties = new Set([
    "start", "colour", "width", "pnts", "layer", "rank", "reversed", "cached_objs", "cached_start", "cached_pnts", "cached_reversed",
    "rows", "cols",
]);

Table.prototype.create_objs = function() {
    var x_len = distance(this.pnts[0], this.pnts[1]);
    var y_len = distance(this.pnts[1], this.pnts[2]);
    var line_maker = new LineMaker(
        this.pnts[0], this.pnts[1], this.pnts[2], this.begin(), this.end(),
        this.colour, this.width, this.layer);
    var lines = [
        [[0, 0, 0], [1, 0, x_len]],
        [[1, 0, x_len], [1, 1, x_len + y_len]],
        [[1, 1, x_len + y_len], [0, 1, 2 * x_len + y_len]],
        [[0, 1, 2 * x_len + y_len], [0, 0, 2 * x_len + 2 * y_len]],
    ];
    var t = 2 * x_len + 2 * y_len;
    var s = 2;
    for (var r = 1; r < this.rows; r++) {
        lines.push([
            [0, r / this.rows, t + s * (r / this.rows * y_len)],
            [1.0, r / this.rows, t + s * (r / this.rows * y_len + x_len)]]);
    }
    for (var c = 1; c < this.cols; c++) {
        lines.push([
            [c / this.cols, 0, t + s * (c / this.cols * x_len)],
            [c / this.cols, 1.0, t + s * (c / this.cols * x_len + y_len)]]);
    }
    var max_time = lines
        .map(function (l) { return l[1][2]; })
        .reduce(function (a,b) { return Math.max(a, b); });
    for (var line of lines) {
        line[0][2] /= max_time;
        line[1][2] /= max_time;
    }
    return lines.map(function (l) { return line_maker.make_line.apply(line_maker, l); });
}

// Text

// valign and halign are either -1 (left/top), 0 (centre), or 1 (right/bottom).
function Text(letters, centre, x_axis, y_axis, start_time, colour, font, valign, halign, layer) {
    if (letters.length < 1) {
        console.log("ERROR: tried to construct text with not enough letters");
    }
    Stroke.call(this, start_time, colour, /*width=*/0, layer);
    this.pnts = [{x: centre.x,
                  y: centre.y,
                  time: 0,
                  seq_id: centre.seq_id},
                 {x: x_axis.x,
                  y: x_axis.y,
                  time: 0,
                  seq_id: x_axis.seq_id},
                 {x: y_axis.x,
                  y: y_axis.y,
                  time: letters[letters.length-1].time,
                  seq_id: y_axis.seq_id}];
    this.letters = letters;
    this.font = font;
    this.valign = valign;
    this.halign = halign;
}
Text.prototype = Object.create(Stroke.prototype);
Text.prototype.constructor = Text;

Text.measuring_canvas_singleton = $("<canvas></canvas>").get(0);
Text.measuring_ctx_singleton = Text.measuring_canvas_singleton.getContext("2d");

Text.prototype.expected_properties = new Set([
    "start", "colour", "width", "pnts", "layer", "rank", "letters", "font", "valign", "halign",
]);

Text.prototype.push_events_into = function(arr) {
    var ctx = Text.measuring_ctx_singleton;

    // Split the text into lines.
    var lines = [];
    var current_line = [];
    for (var letter of this.letters) {
        if (letter.char === "\n") {
            lines.push(current_line);
            current_line = [];
        } else {
            current_line.push(letter);
        }
    }
    lines.push(current_line);

    // Take measurements.
    ctx.font = this.font;
    ctx.fillStype = this.colour;
    var widths = lines.map(line => ctx.measureText(line.map(letter => letter.char).join("")).width);
    var height_measure = ctx.measureText("X");
    var height = height_measure.actualBoundingBoxAscent + height_measure.actualBoundingBoxDescent;
    var line_height = height * 1.5;
    var total_height = line_height * (lines.length - 1) + height;
    var total_width = Math.max(...widths);
    var top = null;
    if (this.valign < 0) {
        top = 0;
    } else if (this.valign > 0) {
        top = -1 * total_height;
    } else {
        top = -0.5 * total_height;
    }

    // Figure out how much to scale time by.
    var total_time_original = this.letters[this.letters.length-1].time;
    var total_time_current = this.end() - this.begin();
    var time_scale = total_time_original > 0 ? total_time_current / total_time_original : 1.0;

    var letter_cnt = 0;
    for (var i = 0; i < lines.length; i++) {
        for (var j = 0; j < lines[i].length; ++j) {
            var letter = lines[i][j];
            var time = this.start + letter.time * time_scale;
            var seq_id = this.pnts[0].seq_id + (letter_cnt / this.letters.length);

            // Figure out where to place the letter.
            var voffset = top + i * line_height + height;
            var line_width = widths[i];
            var left = null;
            if (this.halign < 0) {
                left = 0;
            } else if (this.halign > 0) {
                left = -1 * line_width;
            } else {
                left = -0.5 * line_width;
            }
            var substr = lines[i].slice(0, j+1).map(letter => letter.char).join("");
            var char = lines[i][j].char;
            var substr_width = ctx.measureText(substr).width;
            var char_width = ctx.measureText(char).width;
            var hoffset = left + substr_width - char_width;

            arr.push(new TextEvent(this.pnts[0],
                                   this.pnts[1],
                                   this.pnts[2],
                                   hoffset,
                                   voffset,
                                   char,
                                   time,
                                   seq_id,
                                   this.colour,
                                   this.font)
                    );
            letter_cnt++;
        }
    }
}

// TODO Implement reverse for text.

// TRANSFORM

function Transform(start, layer) {
    this.start = start;
    this.deltas = [];
    this.layer = layer;
    this.rank = null;
}

Transform.prototype.expected_properties = new Set([
    "start", "deltas", "layer", "rank",
]);

Transform.prototype.toJSON = makeJSONEncoder({
    // Properties to transform to a wire-safe format (need to be converted back after deserialize).
    deltas: (ds => ds.map(function (d) {
        var serialized_d = {};
        Object.assign(serialized_d, d);
        serialized_d.m = serialize_matrix(serialized_d.m);
        return serialized_d;
    })),
    layer: (layer => layer.id),
});

Transform.prototype.reifyFromJSON = function() {
    // Map these properties back to their proper format.
    for (var d of this.deltas) {
        d.m = deserialize_matrix(d.m);
    }
    this.layer = get_layer_by_id(this.layer);
}

function TransformEval(args) {
    args[0] = this.m.multiply(args[0]);
}

Transform.prototype.push_events_into = function(arr) {
    for (var i = 0; i < this.deltas.length; i++) {
        arr.push({
            m: this.deltas[i].m,
            time: this.deltas[i].time + this.start,
            seq_id: this.deltas[i].seq_id,
            eval: TransformEval,
        });
    }
}

Transform.prototype.begin = function() {
    return this.start;
}

Transform.prototype.end = function() {
    if (this.deltas.length > 0) {
        return this.start + this.deltas[this.deltas.length-1].time;
    } else {
        return this.start;
    }
}

Transform.prototype.shallow_copy = function() {
    var cpy = Object.create(this.__proto__);
    Object.assign(cpy, this);
    return cpy;
}

Transform.prototype.clone = function() {
    var duplicate = new Transform(this.start, this.layer);
    duplicate.deltas = this.deltas.map(function(delta) {
        var duplicate_delta = Object.assign({}, delta);
        duplicate_delta.seq_id = current_seq_id++;
        duplicate_delta.m = getIdentityMatrix();
        duplicate_delta.m.a = delta.m.a;
        duplicate_delta.m.b = delta.m.b;
        duplicate_delta.m.c = delta.m.c;
        duplicate_delta.m.d = delta.m.d;
        duplicate_delta.m.e = delta.m.e;
        duplicate_delta.m.f = delta.m.f;
        return duplicate_delta;
    });
    return duplicate;
}

Transform.prototype.reverse = function() {
    var old_times = this.deltas.map(function (p) { return p.time; });
    var last = old_times[old_times.length-1];
    var old_seq_ids = this.deltas.map(function (p) { return p.seq_id; });
    this.deltas.reverse();
    for (var i = 0; i < this.deltas.length; i++) {
        this.deltas[i].time = last - old_times[this.deltas.length-i-1];
        this.deltas[i].seq_id = old_seq_ids[i];
        this.deltas[i].m = invert(this.deltas[i].m);
    }
}

// VISIBILITY

// action is either: true for show this layer (and all sublayers)
//                   false for hide this layer (and all sublayers)
//                   identifier for show this layer and show sublayer with matching identifier and hide all other sublayers
function VisibilityEvent(action, time, seq_id, layer) {
    this.action = action;
    this.start = time;
    this.seq_id = seq_id;
    this.layer = layer;
    this.rank = null;

    this.makeTimeProperty();
}

VisibilityEvent.prototype.expected_properties = new Set([
    "action", "start", "seq_id", "layer", "rank", "time",
]);

VisibilityEvent.prototype.toJSON = makeJSONEncoder({
    // Properties to discard (need to be reset after deserialize).
    time: null,
    // Properties to transform to a wire-safe format (need to be converted back after deserialize).
    layer: (layer => layer.id),
});

VisibilityEvent.prototype.reifyFromJSON = function() {
    // Map these properties back to their proper format.
    this.layer = get_layer_by_id(this.layer);

    // Rebuild some properties that need to be created fresh.
    this.makeTimeProperty();
}

VisibilityEvent.prototype.makeTimeProperty = function() {
    // Define time as an alias for start
    Object.defineProperty(this, "time", {
        enumerable: true,
        configurable: true,
        get(){
            return this.start;
        },
        set(value){
            this.start = value;
        }
    });
}

VisibilityEvent.prototype.is_visible = function(target = null) {
    if (this.action === true) {
        return true;
    } else if (this.action === false) {
        return false;
    } else if (target === null || target === this.action) {
        return true;
    } else {
        return false;
    }
}

// Two args:
//    args[0] is the target whose visibility we are querying. Will be null for this layer, and something else for sublayers
//    args[1] is where the output should be placed. Should be true for visible, false otherwise
VisibilityEvent.prototype.eval = function(args) {
    var target = args[0];
    args[1] = this.is_visible(target);
}

VisibilityEvent.prototype.push_events_into = function(arr) {
    arr.push(this);
}

VisibilityEvent.prototype.begin = function() {
    return this.start;
}

VisibilityEvent.prototype.end = function() {
    return this.start;
}

VisibilityEvent.prototype.shallow_copy = function() {
    var cpy = Object.create(this.__proto__);
    Object.assign(cpy, this);
    return cpy;
}

VisibilityEvent.prototype.clone = function() {
    return new VisibilityEvent(this.action, this.time, current_seq_id++, this.layer);
}

VisibilityEvent.prototype.reverse = function() {}

// TRANSFORM LAYER SINK

function TransformLayerSink(layer) {
    this.active_layer = layer;
    this.active_layer.redraw_on_transform_change = false;
    this.active_transform = null;
    this.active_bucket = null;
}

TransformLayerSink.prototype.finalize = function() {
    if (this.active_transform !== null) {
        this.active_layer.finalize_event(this.active_transform);
    }
    this.active_layer.redraw_on_transform_change = true;
}

TransformLayerSink.prototype.process = function(matrix) {
    if (this.active_transform === null) {
        this.active_transform = new Transform(current_project_time, this.active_layer);
        this.active_layer.transforms.push(this.active_transform);
        this.active_bucket = Math.floor(current_project_time / bucket_size);
        addToBucket(this.active_layer.transform_buckets, this.active_bucket, this.active_transform);
    }

    var bucket = Math.floor(current_project_time / bucket_size);
    var delta = {
        m: matrix,
        time: current_project_time - this.active_transform.start,
        seq_id: current_seq_id++,
    };
    this.active_transform.deltas.push(delta);
    if (bucket != this.active_bucket) {
        for (var b = this.active_bucket + 1; b <= bucket; ++b) {
            addToBucket(this.active_layer.transform_buckets, b, this.active_transform);
        }
        this.active_bucket = bucket;
    }
}

TransformLayerSink.prototype.invert_through_self_transform = false;

// TRANSFORM EVENT SINK

function TransformEventSink(layer) {
    this.active_layer = layer;
}

TransformEventSink.prototype.finalize = function() {
}

TransformEventSink.prototype.process = function(matrix) {
    for (var stroke of selection) {
        for (var pnt of stroke.pnts) {
            // TODO: maybe this svg_point thing is too slow ... profile!
            var svg_pnt = getSVGElement().createSVGPoint();
            svg_pnt.x = pnt.x;
            svg_pnt.y = pnt.y;
            svg_pnt = svg_pnt.matrixTransform(matrix);
            pnt.x = svg_pnt.x;
            pnt.y = svg_pnt.y;
        }
    }
    this.active_layer.last_draw = null;
}

TransformEventSink.prototype.invert_through_self_transform = true;

// VIEWPORT ACTION

function ViewportAction(safety_margin = 5, scale_per_pixel = 0.01) {
    this.safety_margin = safety_margin;
    this.scale_per_pixel = 0.003;

    this.initial_point = null;
    this.last_point = null;
    this.current_point = null;
    this.guide_point = null;

    [this.rotation, this.rotation_filter] = RotationAndUniformScaleMaker(true, false);
    this.translation = TranslationMaker(true, true);
    this.translation_filter = function() { return true; };
    this.current_action = null;
    this.current_filter = null;
}

ViewportAction.prototype.mouseup = function(event) {
    this.initial_point = null;
    this.last_point = null;
    this.current_point = null;
    this.guide_point = null;
    this.current_action = null;
    this.current_filter = null;
};

ViewportAction.prototype.mousedown = function(event) {
    if (this.current_action === null) {
        var pnt = getMousePos(event)
        var canvas = document.getElementById("tool-overlay");
        var centre = { x: canvas.width / 2, y: canvas.height / 2 };
        if (event.which === 1) {
            this.current_action = this.translation;
            this.current_filter = this.translation_filter;
        } else if (event.which === 3) {
            // Check if we pass the point filter
            if (!this.rotation_filter(centre, pnt)) {
                return;
            }
            this.current_action = this.rotation;
            this.current_filter = this.rotation_filter;
        }
        this.initial_point = pnt;
        this.current_point = this.initial_point;
        this.guide_point = centre;
        /* var ctx = document.getElementById("tool-overlay").getContext("2d");
           ctx.clearRect(0, 0, 1280, 720);
           ctx.beginPath();
           ctx.arc(this.guide_point.x, this.guide_point.y, 5, 0, 2 * Math.PI);
           ctx.fillStyle = "#FF0000";
           ctx.fill();*/
    }
};

ViewportAction.prototype.mousemove = function(event) {
    if (this.current_action !== null) {
        var pnt = getMousePos(event);

        // Check if we pass the point filter
        if (!this.current_filter(this.guide_point, pnt)) {
            return;
        }

        this.last_point = this.current_point;
        this.current_point = pnt;

        var transform = this.current_action(this.guide_point,
                                            this.initial_point,
                                            this.last_point,
                                            this.current_point);
        viewport_matrix = transform.multiply(viewport_matrix);
    }
};

ViewportAction.prototype.wheel = function(event) {
    if (event.originalEvent.deltaMode != 0) {
        console.log("ERROR: wheel event with non pixel deltaMode");
        return;
    }

    var canvas = document.getElementById("tool-overlay");
    var pnt = getMousePos(event);
    var scale_amount = Math.pow(1 - this.scale_per_pixel, event.originalEvent.deltaY);
    var scale_matrix = matrixMaker.scaleAbout(pnt.x, pnt.y, scale_amount, scale_amount);
    viewport_matrix = scale_matrix.multiply(viewport_matrix);
}

ViewportAction.prototype.finish = function() {
    this.mouseup();
    /* var ctx = document.getElementById("tool-overlay").getContext("2d");
       ctx.clearRect(0, 0, 1280, 720);
    */
    $("#tool-overlay").off("contextmenu");
}

ViewportAction.prototype.start = function() {
    $("#tool-overlay").on("contextmenu", function(event) {
        event.preventDefault();
    });
    this.initial_point = null;
    this.last_point = null;
    this.current_point = null;
    this.current_action = null;
    this.current_filter = null;
}

ViewportAction.prototype.tick = function() { /* do nothing */ }

// TRANSFORM ACTION

function TransformAction(matrix_fun, uses_guide_point, point_filter) {
    // matrix_fun signature:
    // matrix_fun(guide_point, initial_point, last_point, current_point)
    this.active_sink = null;
    this.active_layer = null;
    this.matrix_fun = matrix_fun;
    this.point_filter = point_filter;
    this.uses_guide_point = uses_guide_point;

    this.guide_point = null;
    this.initial_point = null;
    this.last_point = null;
    this.current_point = null;
}

TransformAction.prototype.mouseup = function(event) {
    if (this.active_sink !== null) {
        this.active_sink.finalize();
        this.active_sink = null;
        this.active_layer = null;
        this.initial_point = null;
        this.last_point = null;
        this.current_point = null;
    }
};

TransformAction.prototype.mousedown = function(event) {
    if (this.active_sink === null) {
        if (event.which === 1) {
            // If we need a guide point, check that we have one
            if (this.uses_guide_point && this.guide_point === null) {
                return;
            }

            // Check if we pass the point filter
            var pnt = getMousePos(event)
            if (this.point_filter && !this.point_filter(this.guide_point, pnt)) {
                return;
            }

            this.initial_point = pnt;
            this.current_point = this.initial_point;
            this.active_layer = current_layer;
            this.active_sink = get_new_transform_sink(this.active_layer);
        } else if (event.which === 3 && this.uses_guide_point) {
            this.guide_point = getMousePos(event);
            var ctx = document.getElementById("tool-overlay").getContext("2d");
            ctx.clearRect(0, 0, 1280, 720);
            ctx.beginPath();
            ctx.arc(this.guide_point.x, this.guide_point.y, 5, 0, 2 * Math.PI);
            ctx.fillStyle = "#FF0000";
            ctx.fill();
        }
    }
};

TransformAction.prototype.mousemove = function(event) {
    if (this.active_sink !== null) {
        var pnt = getMousePos(event);

        // Check if we pass the point filter
        if (this.point_filter && !this.point_filter(this.guide_point, pnt)) {
            return;
        }

        this.last_point = this.current_point;
        this.current_point = pnt;
        // Here's where we compute what the transform should be
        var base_transform = this.matrix_fun(this.guide_point,
                                             this.initial_point,
                                             this.last_point,
                                             this.current_point);
        // We need to invert "through" the transform matrices of our ancestors.
        var ancestor_transform = (this.active_layer.parent === null ?
                                  viewport_matrix :
                                  findTransformMatrix(this.active_layer.parent));
        var self_transform = findTransformMatrix(this.active_layer);
        var invert_transform = (this.active_sink.invert_through_self_transform ?
                                self_transform :
                                ancestor_transform);
        var actual_transform = invert(invert_transform).multiply(base_transform).multiply(invert_transform);

        // Feed the final matrix to our sink for processing.
        this.active_sink.process(actual_transform);
    }
};

TransformAction.prototype.finish = function() {
    this.mouseup();
    var ctx = document.getElementById("tool-overlay").getContext("2d");
    ctx.clearRect(0, 0, 1280, 720);
    $("#tool-overlay").off("contextmenu");
}

TransformAction.prototype.start = function() {
    $("#tool-overlay").on("contextmenu", function(event) {
        event.preventDefault();
    });
    this.guide_point = null;
    this.initial_point = null;
    this.last_point = null;
    this.current_point = null;
}

TransformAction.prototype.tick = function() { /* do nothing */ }

function ClickAndDragAction(make_object) {
    this.start_pnt = null;
    this.start_time = null;
    this.make_object = make_object;
}

ClickAndDragAction.prototype.mousedown = function(event) {
    this.start_pnt = getMousePos(event);
    this.start_time = current_project_time;
}

ClickAndDragAction.prototype.mouseup = function(event) {
    var end_pnt = getMousePos(event);
    var end_time = current_project_time;

    var obj = this.make_object(this.start_pnt, end_pnt, this.start_time, end_time);
    set_obj_layer(obj, current_layer);
    draw_tmp_object(null);
}

ClickAndDragAction.prototype.mousemove = function(event) {
    var end_pnt = getMousePos(event);
    var end_time = current_project_time;

    var tmp_obj = this.make_object(this.start_pnt, end_pnt, this.start_time, end_time);
    draw_tmp_object(tmp_obj);
}

ClickAndDragAction.prototype.tick = function(event) {}
ClickAndDragAction.prototype.start = function(event) {}
ClickAndDragAction.prototype.finish = function(event) {}

// Line ClickAndDragAction
function make_line(start_pnt, end_pnt, start_time, end_time) {
    var start = {x: start_pnt.x, y: start_pnt.y, seq_id: current_seq_id++};
    var end = {x: end_pnt.x, y: end_pnt.y, seq_id: current_seq_id++};
    return new Line(start, end, start_time, end_time,
                    get_current_colour(), get_current_width(),
                    null);
}

// Snapped line ClickAndDragAction
function make_snapped_line(start_pnt, end_pnt, start_time, end_time) {
    var dx = end_pnt.x - start_pnt.x;
    var dy = end_pnt.y - start_pnt.y;
    var angle = Math.atan2(dy, dx);
    var snapped_angle = Math.round(angle / (Math.PI/4)) * Math.PI/4;
    var projection = Math.cos(snapped_angle) * dx + Math.sin(snapped_angle) * dy;
    var new_dx = projection * Math.cos(snapped_angle);
    var new_dy = projection * Math.sin(snapped_angle);
    var start = {x: start_pnt.x, y: start_pnt.y, seq_id: current_seq_id++};
    var end = {x: start_pnt.x + new_dx, y: start_pnt.y + new_dy, seq_id: current_seq_id++};
    return new Line(start, end, start_time, end_time,
                    get_current_colour(), get_current_width(),
                    null);
}

// Rectangle ClickAndDragAction
function make_rect(start_pnt, end_pnt, start_time, end_time) {
    var start = {x: start_pnt.x, y: start_pnt.y, seq_id: current_seq_id++};
    var end = {x: end_pnt.x, y: end_pnt.y, seq_id: current_seq_id++};
    return new Rectangle(start, end, start_time, end_time,
                         get_current_colour(), get_current_width(),
                         null);
}

// Table ClickAndDragAction
function make_table(start_pnt, end_pnt, start_time, end_time) {
    var start = {x: start_pnt.x, y: start_pnt.y, seq_id: current_seq_id++};
    var end = {x: end_pnt.x, y: end_pnt.y, seq_id: current_seq_id++};
    return new Table(start, end, start_time, end_time,
                     get_current_table_rows(), get_current_table_cols(),
                     get_current_colour(), get_current_width(),
                     null);
}

// Circle ClickAndDragAction
function make_circle(start_pnt, end_pnt, start_time, end_time) {
    var centre = {x: start_pnt.x, y: start_pnt.y, seq_id: current_seq_id++};
    var radius = distance(start_pnt, end_pnt);
    var x_axis = {x: start_pnt.x + 1, y: start_pnt.y, seq_id: current_seq_id++};
    var y_axis = {x: start_pnt.x, y: start_pnt.y + 1, seq_id: current_seq_id++};
    return new Ellipse(centre, x_axis, y_axis, radius, radius, start_time, end_time,
                       get_current_colour(), get_current_width(),
                       null);
}

// Ellipse ClickAndDragAction
function make_ellipse(start_pnt, end_pnt, start_time, end_time) {
    var centre = {x: start_pnt.x, y: start_pnt.y, seq_id: current_seq_id++};
    var hradius = Math.abs(end_pnt.x - start_pnt.x);
    var vradius = Math.abs(end_pnt.y - start_pnt.y);
    var x_axis = {x: start_pnt.x + 1, y: start_pnt.y, seq_id: current_seq_id++};
    var y_axis = {x: start_pnt.x, y: start_pnt.y + 1, seq_id: current_seq_id++};
    return new Ellipse(centre, x_axis, y_axis, hradius, vradius, start_time, end_time,
                       get_current_colour(), get_current_width(),
                       null);
}

// TextAction.
function TextAction() {
    this.reset();
}

TextAction.prototype.keydown = function(event) {
    event.preventDefault();

    if (this.start_time === null) {
        // If there is no textbox currently active, ignore typing.
        return;
    }

    if (event.key === "Enter" && event.shiftKey) {
        // Shift + Enter ends the current textbox.
        this.maybe_create_object();
        this.reset();
    } else if (event.key === "Backspace") {
        // Backspace removes letters.
        if (this.letters.length > 0) {
            this.letters.pop();
            this.draw_tmp();
        }
    } else if (event.key === "Enter" || event.key.length === 1) {
        // Any other printable character is appended to the list of letters.
        var char = event.key === "Enter" ? "\n" : event.key;
        var time = current_project_time - this.start_time;
        this.letters.push({
            time: time,
            char: char,
        });
        this.draw_tmp();
    }
}

TextAction.prototype.mousedown = function(event) {
    this.maybe_create_object();
    this.reset();
    this.start_pnt = getMousePos(event);
    this.start_time = current_project_time;
    this.wants_keyboard_input = true;
}

TextAction.prototype.mouseup = function(event) {
}

TextAction.prototype.mousemove = function(event) {
}

TextAction.prototype.tick = function(event) {}
TextAction.prototype.start = function(event) {}
TextAction.prototype.finish = function(event) {
    this.maybe_create_object();
}

TextAction.prototype.reset = function() {
    this.start_pnt = null;
    this.start_time = null;
    this.letters = [];
    this.wants_keyboard_input = false;

    var font_size = get_current_text_size();
    var text_style = get_current_text_style();
    var font_style = text_style.italic ? "italic" : "normal";
    var font_weight = text_style.weight;
    var font_family = text_style.family;
    this.font = `${font_style} ${font_weight} ${font_size}px ${font_family}`;
    console.log(this.font);
    this.color = get_current_colour();
    [this.valign, this.halign] = get_current_text_alignment();
}

TextAction.prototype.maybe_create_object = function() {
    if (this.letters.length > 0) {
        debug = true;
        var obj = make_text(this.letters, this.start_pnt, this.start_time, this.color,
                            this.font, this.valign, this.halign);
        set_obj_layer(obj, current_layer);
    }
    draw_tmp_object(null);
}

TextAction.prototype.draw_tmp = function() {
    var tmp_obj = null;
    if (this.letters.length > 0) {
        tmp_obj = make_text(this.letters, this.start_pnt, this.start_time, this.color,
                            this.font, this.valign, this.halign);
    }
    draw_tmp_object(tmp_obj);
}

function make_text(letters, start_pnt, start_time, color, font, valign, halign) {
    var center = {x: start_pnt.x, y: start_pnt.y, seq_id: current_seq_id++};
    var x_axis = {x: center.x + 1, y: center.y, seq_id: current_seq_id++};
    var y_axis = {x: center.x, y: center.y + 1, seq_id: current_seq_id++};
    var layer = null;
    return new Text(letters, center, x_axis, y_axis, start_time, color, font, valign, halign, layer);
}

// PolygonAction
function PolygonAction() {
    this.start();
}

PolygonAction.prototype.mousedown = function(event) {
    if (this.start_time === null) {
        this.start_time = current_project_time;
    }
    var tolerance = 5;
    var pnt = getMousePos(event);
    if (this.pnts.length > 0 && distance(pnt, this.pnts[this.pnts.length-1]) < tolerance) {
        this.finalize();
        return;
    }
    if (this.pnts.length > 0 && distance(pnt, this.pnts[0]) < tolerance) {
        this.pnts.push({
            x: this.pnts[0].x,
            y: this.pnts[0].y,
            time: current_project_time - this.start_time,
            seq_id: current_seq_id++,
        });
        this.finalize();
        return;
    }
    this.pnts.push({
        x: pnt.x,
        y: pnt.y,
        time: current_project_time - this.start_time,
        seq_id: current_seq_id++,
    });
    this.draw_tmp(null);
}

PolygonAction.prototype.mousemove = function(event) {
    //this.draw_tmp(getMousePos(event));
}

PolygonAction.prototype.mousemove_nodrag = function(event) {
    this.draw_tmp(getMousePos(event));
}

PolygonAction.prototype.mouseup = function(event) {
}

PolygonAction.prototype.draw_tmp = function(last_pnt) {
    console.log('called');
    var pnts = this.pnts.slice(); // copy
    if (last_pnt !== null) {
        pnts.push({
            x: last_pnt.x,
            y: last_pnt.y,
            time: current_project_time - this.start_time,
            seq_id: current_seq_id,
        });
    }
    if (pnts.length < 2) return;
    var polygon = new Polygon(
        pnts, this.start_time, get_current_colour(), get_current_width(), null);
    draw_tmp_object(polygon);
}

PolygonAction.prototype.finalize = function() {
    if (this.pnts.length >= 2) {
        var polygon = new Polygon(
            this.pnts, this.start_time, get_current_colour(), get_current_width(), null);
        set_obj_layer(polygon, current_layer);
    }
    draw_tmp_object(null);
    this.start();
}

PolygonAction.prototype.tick = function() {}
PolygonAction.prototype.start = function() {
    this.start_time = null;
    this.pnts = [];
}

PolygonAction.prototype.finish = function() {
    draw_tmp_object(null);
    this.start();
}

// PAINT ACTION

function PaintAction(is_eraser = false) {
    this.active_stroke = null;
    this.active_layer = null;
    this.active_bucket = null;
    this.is_eraser = is_eraser;
}

PaintAction.prototype.mouseup = function(event) {
    if (this.active_stroke !== null) {
        this.active_layer.finalize_event(this.active_stroke);
        this.active_stroke = null;
        this.active_layer = null;
        this.active_bucket = null;
    }
};

PaintAction.prototype.mousedown = function(event) {
    if (this.active_stroke === null && event.which === 1) {
        this.mouse_pos = getMousePos(event);
        this.active_layer = current_layer;
        var pos = findTransformedPoint(this.mouse_pos, this.active_layer);
        var start_time = current_project_time;
        var colour = this.is_eraser ? "eraser" : get_current_colour();
        this.active_stroke = new Stroke(start_time,
                                        colour,
                                        get_current_width(),
                                        this.active_layer);
        this.active_stroke.pnts.push({
            x: pos.x,
            y: pos.y,
            time: 0,
            seq_id: current_seq_id++,
        });
        this.active_layer.strokes.push(this.active_stroke);
        this.active_bucket = Math.floor(start_time / bucket_size);
        addToBucket(this.active_layer.stroke_buckets, this.active_bucket, this.active_stroke);
    }
};

PaintAction.prototype.mousemove = function(event) {
    this.mouse_pos = getMousePos(event);
    this.tick();
};

PaintAction.prototype.tick = function() {
    if (this.active_stroke !== null) {
        var pos = findTransformedPoint(this.mouse_pos, this.active_layer);
        // If nothing has changed, just break
        var last_pos = this.active_stroke.pnts[this.active_stroke.pnts.length-1];
        if (last_pos.x == pos.x && last_pos.y == pos.y) {
            return;
        }
        var project_time = current_project_time;
        var pnt = {
            x: pos.x,
            y: pos.y,
            time: project_time - this.active_stroke.start,
            seq_id: current_seq_id++,
        };
        this.active_stroke.pnts.push(pnt);
        var bucket = Math.floor(project_time / bucket_size);
        if (bucket != this.active_bucket) {
            for (var b = this.active_bucket + 1; b <= bucket; ++b) {
                addToBucket(this.active_layer.stroke_buckets, b, this.active_stroke);
            }
            this.active_bucket = bucket;
        }
    }
};

PaintAction.prototype.finish = PaintAction.prototype.mouseup;
PaintAction.prototype.start = function() { /* do nothing */ };

function TranslationMaker(allow_x_motion, allow_y_motion) {
    return function(guide_point, initial_point, last_point, current_point) {
        var dx = allow_x_motion ? current_point.x - last_point.x : 0;
        var dy = allow_y_motion ? current_point.y - last_point.y: 0;
        return matrixMaker.translation(dx, dy);
    };
}

function ScaleMaker(allow_x_scale, allow_y_scale, safety_margin) {
    if (safety_margin === undefined) {
        safety_margin = 5;
    }
    var matrix_function = function(guide_point, initial_point, last_point, current_point) {
        var sx = allow_x_scale
            ? (current_point.x - guide_point.x) / (last_point.x - guide_point.x)
            : 1;
        var sy = allow_y_scale
            ? (current_point.y - guide_point.y) / (last_point.y - guide_point.y)
            : 1;
        return matrixMaker.scaleAbout(guide_point.x, guide_point.y, sx, sy);
    };
    var filter_function = function(guide, pnt) {
        if (Math.abs(guide.x - pnt.x) < safety_margin && allow_x_scale) {
            return false;
        } else if (Math.abs(guide.y - pnt.y) < safety_margin && allow_y_scale) {
            return false;
        } else {
            return true;
        }
    };
    return [matrix_function, filter_function];
}

function distance(p1, p2) {
    var dx = p1.x - p2.x;
    var dy = p1.y - p2.y;
    return Math.sqrt(dx*dx + dy*dy);
}

function RotationAndUniformScaleMaker(allow_rotation, allow_uniform_scale, safety_margin) {
    if (safety_margin === undefined) {
        safety_margin = 5;
    }
    var matrix_function = function(guide_point, initial_point, last_point, current_point) {
        var current_d = distance(guide_point, current_point);
        var last_d = distance(guide_point, last_point);
        var s = allow_uniform_scale ? (current_d / last_d) : 1;
        var current_r = Math.atan2(current_point.y - guide_point.y, current_point.x - guide_point.x);
        var last_r = Math.atan2(last_point.y - guide_point.y, last_point.x - guide_point.x);
        var r = allow_rotation ? (current_r - last_r) : 0;

        var scale_matrix = matrixMaker.scaleAbout(guide_point.x, guide_point.y, s, s);
        var rotation_matrix = matrixMaker.rotateAbout(guide_point.x, guide_point.y, r);
        return scale_matrix.multiply(rotation_matrix);
    };
    var filter_function = function(guide, pnt) {
        return (distance(guide, pnt) >= safety_margin);
    };
    return [matrix_function, filter_function];
}

free_translation = TranslationMaker(true, true);
horizontal_translation = TranslationMaker(true, false);
vertical_translation = TranslationMaker(false, true);
[free_scale, free_scale_filter] = ScaleMaker(true, true);
[horizontal_scale, horizontal_scale_filter] = ScaleMaker(true, false);
[vertical_scale, vertical_scale_filter] = ScaleMaker(false, true);
[rotation, rotation_filter] = RotationAndUniformScaleMaker(true, false);
[uniform_scale, uniform_scale_filter] = RotationAndUniformScaleMaker(false, true);
[rotate_and_scale, rotate_and_scale_filter] = RotationAndUniformScaleMaker(true, true);

function make_table_ui() {
    return $("<span>Table (<input type='text' id='table_rows_txt' value='5'> rows by <input type='text' id='table_cols_txt' value='5'> cols)</span>");
}

function make_text_ui() {
    var alignment_selector = $(`<fieldset id="text_alignment_selection" style="display:inline">
                               <legend>Alignment</legend>
                               <label for="top-left">X</label>
                               <input type="radio" name="text-alignment-radio" id="top-left" checked="checked">
                               <label for="top-centre">X</label>
                               <input type="radio" name="text-alignment-radio" id="top-centre">
                               <label for="top-right">X</label>
                               <input type="radio" name="text-alignment-radio" id="top-right">
                               <br/>
                               <label for="middle-left">X</label>
                               <input type="radio" name="text-alignment-radio" id="middle-left">
                               <label for="middle-centre">X</label>
                               <input type="radio" name="text-alignment-radio" id="middle-centre">
                               <label for="middle-right">X</label>
                               <input type="radio" name="text-alignment-radio" id="middle-right">
                               <br/>
                               <label for="bottom-left">X</label>
                               <input type="radio" name="text-alignment-radio" id="bottom-left">
                               <label for="bottom-centre">X</label>
                               <input type="radio" name="text-alignment-radio" id="bottom-centre">
                               <label for="bottom-right">X</label>
                               <input type="radio" name="text-alignment-radio" id="bottom-right">
                               </fieldset>`);
    alignment_selector.find("input").checkboxradio({ icon: false });
    var size_selector = $("<span>Size: <input type='text' id='font_size' value='24'>pt, </span>");
    var font_selector = $("<span><input type='text' id='font_selector' value='Arial:400'>, </span>");
    font_selector.find("#font_selector").fontpicker();
    var span = $("<span>Text (</span>");
    span.append(font_selector);
    span.append(size_selector);
    span.append(alignment_selector);
    span.append(")");
    return span;
}

var actions = [
    {key: "paint", title: "Paint", tool: new PaintAction()},
    {key: "erase", title: "Erase", tool: new PaintAction(/*is_eraser=*/true)},
    {key: "line", title: "Line", tool: new ClickAndDragAction(make_line)},
    {key: "snapped_line", title: "Snapped Line", tool: new ClickAndDragAction(make_snapped_line)},
    {key: "rect", title: "Rectangle", tool: new ClickAndDragAction(make_rect)},
    {key: "table", title: "Table", tool: new ClickAndDragAction(make_table), creation: make_table_ui},
    {key: "poly", title: "Polygon", tool: new PolygonAction},
    {key: "circle", title: "Circle", tool: new ClickAndDragAction(make_circle)},
    {key: "ellipse", title: "Ellipse", tool: new ClickAndDragAction(make_ellipse)},
    {key: "text", title: "Text", tool: new TextAction(), creation: make_text_ui},
    {key: "translate", title: "Translate", tool: new TransformAction(free_translation)},
    {key: "htranslate", title: "Horizontal Translate", tool: new TransformAction(horizontal_translation)},
    {key: "vtranslate", title: "Vertical Translate", tool: new TransformAction(vertical_translation)},
    {key: "scale", title: "Nonuniform Scale", tool: new TransformAction(free_scale, true, free_scale_filter)},
    {key: "hscale", title: "Horizontal Scale", tool: new TransformAction(horizontal_scale, true, horizontal_scale_filter)},
    {key: "vscale", title: "Vertical Scale", tool: new TransformAction(vertical_scale, true, vertical_scale_filter)},
    {key: "rotate", title: "Rotation", tool: new TransformAction(rotation, true, rotation_filter)},
    {key: "uscale", title: "Uniform Scale", tool: new TransformAction(uniform_scale, true, uniform_scale_filter)},
    {key: "rotate_and_scale", title: "Rotation and Scale", tool: new TransformAction(rotate_and_scale, true, rotate_and_scale_filter)},
    {key: "viewport_transform", title: "Viewport Transform", tool: new ViewportAction()},
];

// Hide/show handlers
function add_visibility_event(layer, action) {
    if (layer === null) {
        return;
    }

    // Make the event
    var event = new VisibilityEvent(action, current_project_time, current_seq_id++, layer);

    // Add it to the layer
    var bucket = Math.floor(current_project_time / bucket_size);
    layer.visibility_events.push(event);
    addToBucket(layer.visibility_buckets, bucket, event);

    // Give the event a rank in the timeline & tell timeline to update itself
    layer.timeline.assign_rank(event);
    layer.timeline.needs_redraw = true;
}

// TODO: figure out proper encapsulation
// TODO: error handling
[make_rename_dialog, begin_rename_layer] = (function() {
    var rename_dialog = null;
    var current_rename_layer = null;
    function begin_rename_layer(layer) {
        $("#rename-error-message").css("visibility", "hidden");
        current_rename_layer = layer;
        $("#layer-rename-name").val(layer.title);
        rename_dialog.dialog("open");
    }
    function maybe_end_rename_layer() {
        var name = $("#layer-rename-name").val();
        if (layer_name_taken(name) && current_rename_layer.title !== name) {
            $("#rename-error-message").css("visibility", "visible");
        } else {
            current_rename_layer.title = name;
            rename_dialog.dialog("close");
            update_layers();
        }
    }

    function make_rename_dialog() {
        rename_dialog = $( "#rename-layer" ).dialog({
            autoOpen: false,
            height: 230,
            width: 500,
            modal: true,
            buttons: {
                "Ok": maybe_end_rename_layer,
                "Cancel": function() {
                    rename_dialog.dialog( "close" );
                }
            },
        });

        rename_dialog.find( "form" ).on( "submit", function( event ) {
            event.preventDefault();
            return maybe_end_rename_layer();
        });

        return rename_dialog;
    }

    return [make_rename_dialog, begin_rename_layer];
})();

// TODO: figure out proper encapsulation
// TODO: error handling and stuff
[make_image_dialog, begin_add_image] = (function() {
    var image_dialog = null;
    function begin_add_image() {
        image_dialog.dialog("open");
    }
    function end_add_image() {
        image_dialog.dialog("close");

        var input = document.getElementById("add-image-file");
        if (input.files && input.files[0]) {
            var reader = new FileReader();

            reader.onload = function(e) {
                var data_url = e.target.result;
                new_layer(null, data_url);
            }

            reader.readAsDataURL(input.files[0]);
        }
    }

    function make_image_dialog() {
        image_dialog = $( "#add-image" ).dialog({
            autoOpen: false,
            height: 200,
            width: 350,
            modal: true,
            buttons: {
                "Ok": end_add_image,
                "Cancel": function() {
                    image_dialog.dialog( "close" );
                }
            },
        });

        image_dialog.find( "form" ).on( "submit", function( event ) {
            event.preventDefault();
            return end_add_image();
        });

        return image_dialog;
    }

    return [make_image_dialog, begin_add_image];
})();

// TODO: figure out proper encapsulation
// TODO: error handling
[make_export_dialogs, begin_export_dialog] = (function() {
    var export_setup_dialog = null;
    var export_progress_dialog = null;
    var export_progress_bar = null;
    var export_manager = null;
    var last_calculated_end = null;
    var project_directory_contents = null;
    var directory_browser = null;

    function begin_export_dialog() {
        // Infer the endpoint as 0.5 seconds after the end of the last event.
        // TODO does this need to be faster?
        var end = 0.0;
        for (var layer of layers) {
            for (var event_list of [layer.strokes,
                                    layer.transforms,
                                    layer.visibility_events]) {
                for (var event of event_list) {
                    end = Math.max(end, event.end() / 1000.0);
                }
            }
        }
        end += 0.5;

        // We want to do inference if this is the first time we export or
        // if the endpoint has changed since the last time, but otherwise
        // we just want to persist the previous settings.
        if (end !== last_calculated_end) {
            $("#export-start-time").val("0.00");
            $("#export-end-time").val(end.toFixed(2));
            last_calculated_end = end;
        }

        // Try to list the project directory contents.
        // Define what to do on open success or failure.
        var success_fn = function(data, status) {
            console.log("List project directory success!");
            console.log(data);
            console.log(status);
            project_directory_contents = JSON.parse(data)["project_directory_contents"];
            export_setup_dialog.dialog("open");
        };
        var error_fn = function(data, status) {
            console.log("List project directory errored out!");
            console.log(data);
            console.log(status);
            $("#export-info-message")
                .removeClass("success-message")
                .addClass("error-message")
                .text("Server error listing projects; check console for details or try again.");
            export_info_dialog.dialog("open");
        };

        // List project directory contents.
        $.ajax({
            type: "GET",
            url: "../list_project_directory",
            data: {},
            success: success_fn,
            error: error_fn,
        });
    }

    function cancel_export() {
        export_progress_dialog.dialog("close");
        export_manager.cancel_export();
    }

    function start_export() {
        // Try to get the filepath to export to.
        var directory = directory_browser.getSelection();
        if (directory === null) {
            return;
        }
        var filename = $("#export-filename").val();
        if (filename === "") {
            return;
        }
        var filepath = directory === "" ? filename : directory + "/" + filename;

        // Reset the progress dialog.
        export_progress_bar.find(".ui-progressbar-value").css({
            "background": "#e9e9e9",
        });
        export_progress_bar.progressbar("value", 0);
        $("#export-progress-percent").text(`Current progress: 0.0%`);
        $("#export-progress-time").text(`(0 of ??? seconds)`);
        $("#export-progress-frames").text(`(0 of approximately ??? frames)`);
        export_progress_dialog.dialog({
            buttons: {
                "Cancel Export": cancel_export,
            },
        });

        // Switch to the progress dialog.
        export_setup_dialog.dialog("close");
        export_progress_dialog.dialog("open");

        // Prep for export.
        if (current_action) current_action.finish();
        playing = false;

        // Read params and start the export.
        var fps = parseInt($("#export-fps").val());
        var start_time = parseFloat($("#export-start-time").val());
        var end_time = parseFloat($("#export-end-time").val());
        var width = 1280;
        var height = 720;
        var success_fn = function(data, status) {
            console.log("Export success!");
            console.log(data);
            console.log(status);
            export_progress_bar.find(".ui-progressbar-value").css({
                "background": "green",
            });
            export_progress_dialog.dialog({
                buttons: {
                    "Ok": function() {
                        export_progress_dialog.dialog("close");
                    },
                },
            });
        };
        var error_fn = function(data, status) {
            console.log("Export errored out!");
            console.log(data);
            console.log(status);
            export_progress_bar.find(".ui-progressbar-value").css({
                "background": "red",
            });
            $("#export-progress-percent").text("Error! Export failed!");
            export_progress_dialog.dialog({
                buttons: {
                    "Ok": function() {
                        export_progress_dialog.dialog("close");
                    },
                },
            });
        };
        var progress_fn = function(p) {
            console.log("Request succeeded: " + p.last_request_sent);
            export_progress_bar.progressbar("value", p.progress_percent);
            $("#export-progress-percent").text(`Current progress: ${p.progress_percent.toFixed(1)}%`);
            $("#export-progress-time").text(`(${p.progress_time.toFixed(1)} of ${p.total_time.toFixed(1)} seconds)`);
            $("#export-progress-frames").text(`(${p.progress_frames} of approximately ${p.total_frames} frames)`);
        };
        export_manager = new ExportManager(
            filepath, fps, width, height, start_time, end_time,
            success_fn, error_fn, progress_fn);
        export_manager.do_export();
    }

    function make_export_dialogs() {
        export_setup_dialog = $("#export-setup").dialog({
            autoOpen: false,
            modal: true,
            open: function(event, ui) {
                directory_browser = new SimpleDirectoryBrowser(
                    "export-setup-directory",
                    project_directory_contents,
                    /*allow_select_directory=*/true,
                    /*allow_select_file=*/false,
                    /*initial_path=*/current_project_filepath);
            },
            buttons: {
                "Start Export": start_export,
                "Cancel": function() {
                    export_setup_dialog.dialog("close");
                }
            },
        });
        export_setup_dialog.find("form").on("submit", function( event ) {
            event.preventDefault();
            start_export();
        });

        export_progress_dialog = $("#export-progress").dialog({
            autoOpen: false,
            width: 600,
            modal: true,
            closeOnEscape: false,
            open: function(event, ui) {
                $(this).closest('.ui-dialog').find('.ui-dialog-titlebar-close').hide()
            },
            buttons: {
                "Cancel Export": cancel_export,
            },
        });

        export_progress_bar = $("#export-progress-bar").progressbar({
            max: 100.0,
            value: false,
        });

        export_info_dialog = $("#export-info").dialog({
            autoOpen: false,
            width: 600,
            height: 180,
            modal: true,
            closeOnEscape: false,
            open: function(event, ui) {
                $(this).closest('.ui-dialog').find('.ui-dialog-titlebar-close').hide()
            },
            buttons: {
                "Dismiss":  function() {
                    export_info_dialog.dialog("close");
                },
            },
        });

        return [export_setup_dialog, export_progress_dialog, export_info_dialog];
    }

    return [make_export_dialogs, begin_export_dialog];
})();

function SimpleDirectoryBrowser(element_id, directory_contents, allow_select_directory, allow_select_file, initial_path = "") {
    this.directory_contents = {};
    // Add a leading / to each non-empty directory name, to make processing more uniform.
    for (var key in directory_contents) {
        var val = directory_contents[key];
        key = this.normalizePath(key);
        this.directory_contents[key] = val;
    }

    this.allow_select_directory = allow_select_directory;
    this.allow_select_file = allow_select_file;

    if (typeof initial_path !== "string") {
        initial_path = "";
    }
    this.current_path = this.normalizePath(this.largestValidDirectoryPrefix(initial_path));

    this.jElement = $("#" + element_id).addClass("directory-browser");
    this.updateUI();
}

SimpleDirectoryBrowser.prototype.normalizePath = function(path) {
    if (path === "" || path.startsWith("/")) {
        return path;
    }
    return "/" + path;
};

SimpleDirectoryBrowser.prototype.largestValidDirectoryPrefix = function(initial_path) {
    var valid_path = "";
    var parts = initial_path.split("/");
    for (var i = 0; i < parts.length; i++) {
        var path = parts.slice(0, i+1).join("/");
        if (!(this.normalizePath(path) in this.directory_contents)) {
            break;
        }
        valid_path = path;
    }
    return valid_path;
};

SimpleDirectoryBrowser.prototype.updateUI = function() {
    this.jElement.empty();
    var parts = this.current_path.split("/");
    for (var i = 0; i < parts.length; i++) {
        var path = parts.slice(0, i+1).join("/");
        this.selectEntry(path);
        this.addDirectory(path);
    }
    this.installCallbacks();
};

SimpleDirectoryBrowser.prototype.getValFromEntry = function(contents, entry) {
    for (var i = 0; i < contents.directories.length; i++) {
        if (entry === contents.directories[i]) {
            return "directory-" + i;
        }
    }

    for (var i = 0; i < contents.files.length; i++) {
        if (entry === contents.files[i]) {
            return "file-" + i;
        }
    }

    return "null";
};

SimpleDirectoryBrowser.prototype.getEntryFromVal = function(contents, val) {
    var parts = val.split("-");
    if (parts.length !== 2) {
        return null;
    }
    var type = parts[0];
    var index = parseInt(parts[1]);
    if (type === "file") {
        return contents.files[index];
    }
    if (type === "directory") {
        return contents.directories[index];
    }
    return null;
}

SimpleDirectoryBrowser.prototype.selectEntry = function(path) {
    var parts = path.split("/");
    var context = parts.slice(0, parts.length - 1).join("/");
    var element = parts[parts.length - 1];
    var contents = this.directory_contents[context];
    var level = parts.length - 2;
    if (level < 0) {
        return;
    }
    var val = this.getValFromEntry(contents, element);
    var select = this.jElement.find(`[data-level="${level}"]`);
    select.val(val).selectmenu("refresh");
};

SimpleDirectoryBrowser.prototype.installCallbacks = function(path) {
    var browser = this;
    this.jElement.find("select").on("selectmenuchange", function(event, ui) {
        var level = $(this).attr("data-level");
        browser.setPathUpToLevel(level);
        browser.updateUI();
    });
};

SimpleDirectoryBrowser.prototype.setPathUpToLevel = function(level) {
    this.current_path = "";
    for (var i = 0; i <= level; i++) {
        var contents = this.directory_contents[this.current_path];
        if (contents === undefined) {
            return;
        }
        var select = this.jElement.find(`[data-level="${i}"]`);
        var val = select.val();
        if (val === null) {
            return;
        }
        var entry = this.getEntryFromVal(contents, val);
        if (entry === null) {
            return;
        }
        this.current_path += "/" + entry;
    }
};

SimpleDirectoryBrowser.prototype.addDirectory = function(path) {
    var contents = this.directory_contents[path];
    if (contents === undefined) {
        return;
    }

    var dirs = $('<optgroup label="Directories"></optgroup>');
    for (var i = 0; i < contents.directories.length; i++) {
        var dir = contents.directories[i];
        var entry = $("<option></option>").text(dir + "/").val("directory-" + i).appendTo(dirs);
    }

    var files = $('<optgroup label="Files"></optgroup>');
    for (var i = 0; i < contents.files.length; i++) {
        var file = contents.files[i];
        var entry = $("<option></option>").text(file).val("file-" + i).appendTo(files);
    }

    var level = path.split("/").length - 1;
    var select = ($("<select></select>")
                  .attr("data-level", level)
                  .append('<option selected value="null"></option>')
                  .append(dirs)
                  .append(files)
                  .appendTo(this.jElement)
                  .selectmenu()
                  .selectmenu("menuWidget")
                  .css("max-height", "500px"));
};

SimpleDirectoryBrowser.prototype.isDirectory = function(path) {
    return this.directory_contents[path] !== undefined;
};

SimpleDirectoryBrowser.prototype.getSelection = function() {
    var is_dir = this.isDirectory(this.current_path);
    if (is_dir && !this.allow_select_directory) {
        return null;
    }
    if (!is_dir && !this.allow_select_file) {
        return null;
    }
    if (this.current_path.startsWith("/")) {
        // Remove the leading '/' so that this is a relative path.
        return this.current_path.substring(1);
    }
    return this.current_path;
};

// TODO: figure out proper encapsulation
[make_save_dialogs, begin_save_as_dialog, begin_save] = (function() {
    var save_setup_dialog = null;
    var save_progress_dialog = null;
    var saving = false;
    var project_directory_contents = null;
    var directory_browser = null;

    function begin_save_as_dialog() {
        // Start by trying to list the project directory contents.
        // Define what to do on open success or failure.
        var success_fn = function(data, status) {
            console.log("List project directory success!");
            console.log(data);
            console.log(status);
            project_directory_contents = JSON.parse(data)["project_directory_contents"];
            save_setup_dialog.dialog("open");
        };
        var error_fn = function(data, status) {
            console.log("List project directory errored out!");
            console.log(data);
            console.log(status);
            $("#save-progress-message")
                .removeClass("success-message")
                .addClass("error-message")
                .text("Server error listing projects; check console for details or try again.");
            save_progress_dialog.dialog({
                buttons: {
                    "Dismiss": function() {
                        save_progress_dialog.dialog("close");
                    },
                },
            });
            save_progress_dialog.dialog("open");
        };

        // List project directory contents.
        $.ajax({
            type: "GET",
            url: "../list_project_directory",
            data: {},
            success: success_fn,
            error: error_fn,
        });
    }

    function begin_save() {
        var filepath = current_project_filepath;
        var overwrite = true;
        if (typeof filepath !== "string" || filepath.length === 0) {
            begin_save_as_dialog();
        } else {
            start_save_generic(filepath, overwrite);
        }
    }

    function cancel_save() {
        saving = false;
        save_progress_dialog.dialog("close");
    }

    function start_save_as() {
        var directory = directory_browser.getSelection();
        if (directory === null) {
            return;
        }
        var filename = $("#save-filename").val();
        if (filename === "") {
            return;
        }
        var filepath = directory === "" ? filename : directory + "/" + filename;
        var overwrite = false;
        start_save_generic(filepath, overwrite);
    }

    function start_save_generic(filepath, overwrite) {
        // Reset the progress dialog.
        $("#save-progress-message")
            .removeClass("success-message")
            .removeClass("error-message")
            .text("Writing project to disk, please wait...");
        save_progress_dialog.dialog({
            buttons: {
                "Cancel": cancel_save,
            },
        });

        // Switch to the progress dialog.
        save_setup_dialog.dialog("close");
        save_progress_dialog.dialog("open");

        // Serialize project state.
        var state = serializeState();

        // Define what to do on save success or failure.
        var success_fn = function(data, status) {
            if (saving) {
                console.log("Save success!");
                console.log(data);
                console.log(status);
                var payload = JSON.parse(data);
                var project_filepath = payload.final_project_path;
                if (typeof project_filepath !== "string" || project_filepath.length === 0) {
                    throw "Malformed response from server on save!";
                }
                setProjectFilepath(project_filepath);
                if (payload.path_adjusted_to_avoid_overwrite) {
                    $("#save-progress-message")
                        .addClass("success-message")
                        .removeClass("error-message")
                        .text("Filename adjust to avoid overwrite conflict.");
                    save_progress_dialog.dialog({
                        buttons: {
                            "Dismiss": function() {
                                save_progress_dialog.dialog("close");
                            },
                        },
                    });
                } else {
                    save_progress_dialog.dialog("close");
                }
            }
            saving = false;
        };
        var error_fn = function(data, status) {
            console.log("Save errored out!");
            console.log(data);
            console.log(status);
            $("#save-progress-message")
                .removeClass("success-message")
                .addClass("error-message")
                .text("Server error on save; check console for details or try again.");
            save_progress_dialog.dialog({
                buttons: {
                    "Dismiss": function() {
                        save_progress_dialog.dialog("close");
                    },
                },
            });
            saving = false;
        };

        // Start save.
        saving = true;
        $.ajax({
            type: "POST",
            url: "../save_project",
            data: {
                project_filepath: filepath,
                project_data: state,
                overwrite: overwrite,
            },
            success: success_fn,
            error: error_fn,
        });
    }

    function make_save_dialogs() {
        save_setup_dialog = $("#save-setup").dialog({
            autoOpen: false,
            modal: true,
            open: function(event, ui) {
                directory_browser = new SimpleDirectoryBrowser(
                    "save-setup-directory",
                    project_directory_contents,
                    /*allow_select_directory=*/true,
                    /*allow_select_file=*/false,
                    /*initial_path=*/current_project_filepath);
                var filename = "Project.cnvs";
                if (current_project_filepath !== null) {
                    var parts = current_project_filepath.split("/");
                    filename = parts[parts.length-1];
                }
                $("#save-filename").val(filename);
            },
            buttons: {
                "Save": start_save_as,
                "Cancel": function() {
                    save_setup_dialog.dialog("close");
                },
            },
        });
        save_setup_dialog.find("form").on("submit", function( event ) {
            event.preventDefault();
            start_save_as();
        });

        save_progress_dialog = $("#save-progress").dialog({
            autoOpen: false,
            width: 600,
            height: 180,
            modal: true,
            closeOnEscape: false,
            open: function(event, ui) {
                $(this).closest('.ui-dialog').find('.ui-dialog-titlebar-close').hide()
            },
            buttons: {
                "Cancel": cancel_save,
            },
        });

        return [save_setup_dialog, save_progress_dialog];
    }

    return [make_save_dialogs, begin_save_as_dialog, begin_save];
})();

// TODO: figure out proper encapsulation
[make_open_dialogs, begin_open_dialog] = (function() {
    var open_setup_dialog = null;
    var open_progress_dialog = null;
    var opening = false;
    var project_directory_contents = null;
    var directory_browser = null;

    function begin_open_dialog() {
        // Start by trying to list the project directory contents.
        // Define what to do on open success or failure.
        var success_fn = function(data, status) {
            console.log("List project directory success!");
            console.log(data);
            console.log(status);
            project_directory_contents = JSON.parse(data)["project_directory_contents"];
            open_setup_dialog.dialog("open");
        };
        var error_fn = function(data, status) {
            console.log("List project directory errored out!");
            console.log(data);
            console.log(status);
            $("#open-progress-message")
                .removeClass("success-message")
                .addClass("error-message")
                .text("Server error listing projects; check console for details or try again.");
            open_progress_dialog.dialog({
                buttons: {
                    "Dismiss": function() {
                        open_progress_dialog.dialog("close");
                    },
                },
            });
            open_progress_dialog.dialog("open");
        };

        // List project directory contents.
        $.ajax({
            type: "GET",
            url: "../list_project_directory",
            data: {},
            success: success_fn,
            error: error_fn,
        });
    }

    function cancel_open() {
        opening = false;
        open_progress_dialog.dialog("close");
    }

    function start_open() {
        var filepath = directory_browser.getSelection();
        if (filepath === null) {
            return;
        }

        // Reset the progress dialog.
        $("#open-progress-message")
            .removeClass("success-message")
            .removeClass("error-message")
            .text("Loading project from disk, please wait...");
        open_progress_dialog.dialog({
            buttons: {
                "Cancel": cancel_open,
            },
        });

        // Switch to the progress dialog.
        open_setup_dialog.dialog("close");
        open_progress_dialog.dialog("open");

        // Define what to do on open success or failure.
        var success_fn = function(data, status) {
            if (opening) {
                console.log("Open success!");
                console.log(data);
                console.log(status);
                open_progress_dialog.dialog("close");
                deserializeState(data, filepath);
                // Sanity check that reserilization produces the same result.
                // (Once we start versioning project format, this may no longer always be true).
                var reserialized_state = serializeState();
                if (data !== reserialized_state) {
                    throw "loaded project data failed reserialization sanity check";
                }
            }
            opening = false;
        };
        var error_fn = function(data, status) {
            console.log("Open errored out!");
            console.log(data);
            console.log(status);
            $("#open-progress-message")
                .removeClass("success-message")
                .addClass("error-message")
                .text("Server error on open; check console for details or try again.");
            open_progress_dialog.dialog({
                buttons: {
                    "Dismiss": function() {
                        open_progress_dialog.dialog("close");
                    },
                },
            });
            opening = false;
        };

        // Start open.
        opening = true;
        $.ajax({
            type: "POST",
            url: "../open_project",
            data: {
                project_filepath: filepath,
            },
            success: success_fn,
            error: error_fn,
        });
    }

    function make_open_dialogs() {
        open_setup_dialog = $("#open-setup").dialog({
            autoOpen: false,
            modal: true,
            open: function(event, ui) {
                directory_browser = new SimpleDirectoryBrowser(
                    "open-setup-directory",
                    project_directory_contents,
                    /*allow_select_directory=*/false,
                    /*allow_select_file=*/true,
                    /*initial_path=*/current_project_filepath);
            },
            buttons: {
                "Open": start_open,
                "Cancel": function() {
                    open_setup_dialog.dialog("close");
                },
            },
        });
        open_setup_dialog.find("form").on("submit", function( event ) {
            event.preventDefault();
            start_open();
        });

        open_progress_dialog = $("#open-progress").dialog({
            autoOpen: false,
            width: 600,
            height: 180,
            modal: true,
            closeOnEscape: false,
            open: function(event, ui) {
                $(this).closest('.ui-dialog').find('.ui-dialog-titlebar-close').hide()
            },
            buttons: {
                "Cancel": cancel_open,
            },
        });

        return [open_setup_dialog, open_progress_dialog];
    }

    return [make_open_dialogs, begin_open_dialog];
})();

function resize_timelines() {
    var min_target_width = null;
    for (var layer of layers) {
        var total_width = $(layer.timeline.canvas).parent().width();
        var header_width = $(layer.timeline.canvas).parent().parent().find(".layerhandle-header").width();
        var target_width = total_width - header_width - 50;
        // TODO: Handle case where target width is less than zero.
        if (min_target_width === null || target_width < min_target_width) {
            min_target_width = target_width;
        }
    }
    if (min_target_width === null) {
        // There are no layers!
        return;
    }
    for (var layer of layers) {
        layer.timeline.canvas.width = min_target_width;
        layer.timeline.needs_redraw = true;
    }
}

function distribute_events(events) {
    if (events.length < 3) {
        return;
    }
    var sorted_events = events.slice(); // copy
    sorted_events.sort(function(a, b) { return a.begin() - b.begin(); });
    var begin = sorted_events[0].begin();
    var end = sorted_events[sorted_events.length-1].begin();
    var step = (end - begin) / (sorted_events.length-1);
    for (var i = 0; i < sorted_events.length; i++) {
        sorted_events[i].start = begin + step * i;
    }
}

function distribute_spaces(events) {
    if (events.length < 2) {
        return;
    }
    var sorted_events = events.slice(); // copy
    sorted_events.sort(function(a, b) { return a.begin() - b.begin(); });
    var begin = sorted_events[0].begin();
    var end = sorted_events.map(function(e) { return e.end(); }).reduce(function(a,b) { return Math.max(a,b); });
    var total_time = sorted_events.reduce( function(total, event) {
        return total + (event.end() - event.begin());
    }, 0);
    var total_space = (end - begin) - total_time; // May be positive or negative
    var step = total_space / (sorted_events.length-1);
    for (var i = 1; i < sorted_events.length; i++) {
        sorted_events[i].start = sorted_events[i-1].end() + step;
    }
}

function set_event_end(event, time, stretch) {
    if (!stretch) {
        // The easy case
        event.start = time - (event.end() - event.begin());
        return;
    }
    var begin = Math.min(time, event.begin());
    var old_duration = event.end() - event.begin();
    var new_duration = time - begin;
    if (new_duration == 0 || old_duration == 0) {
        // We don't do this.
        return;
    }
    event.start = time - new_duration;
    scale_deltas(event, new_duration / old_duration);
}

function set_event_start(event, time, stretch) {
    if (!stretch) {
        // The easy case
        event.start = time;
        return;
    }
    var end = Math.max(time, event.end());
    var old_duration = event.end() - event.begin();
    var new_duration = end - time;
    if (new_duration == 0 || old_duration == 0) {
        // We don't do this.
        return;
    }
    event.start = time;
    scale_deltas(event, new_duration / old_duration);
}

function cut_event(event, time) {
    var deltas = get_deltas(event);
    if (deltas.length < 1) {
        return [event];
    }
    if (time < event.begin() || time > event.end()) {
        return [event];
    }
    // Find the index of the delta closest to the time
    var best_index = 0;
    for (var i = 1; i < deltas.length; i++) {
        if (Math.abs(deltas[i].time + event.begin() - time) <
            Math.abs(deltas[best_index].time + event.begin() - time)) {
            best_index = i;
        }
    }
    if (best_index == 0 || best_index == deltas.length-1) {
        return [event];
    }
    var first = event;
    var second = event.clone();
    var first_deltas = get_deltas(first);
    first_deltas.splice(best_index+1);

    // Now where we cut the second event depends on the event type.
    // Stroke events need to duplicate the element at best_index.
    // Transform events should not.
    var second_deltas = get_deltas(second);
    if (event instanceof Stroke) {
        second_deltas.splice(0, best_index);
        var shift_amount = second_deltas[0].time;
        for (var delta of second_deltas) {
            delta.time -= shift_amount;
        }
        // We want this to be *just slightly* past the end of the first event,
        // so that there is no overlap in the timeline. So we directly compute the
        // end of the first event and then add a small epsilon.
        second.start = first.start + first_deltas[first_deltas.length-1].time + 1e-6;
    } else if (event instanceof Transform) {
        second_deltas.splice(0, best_index+1);
        var shift_amount = second_deltas[0].time;
        for (var delta of second_deltas) {
            delta.time -= shift_amount;
        }
        second.start += shift_amount;
    } else {
        console.log("ERROR: Unrecognized event type in cut_event");
        return null;
    }
    return [first, second];
}

function reverse_events(events) {
    var begin = events.map(function(e) { return e.begin(); }).reduce(function(a,b) { return Math.min(a,b); });
    var end = events.map(function(e) { return e.end(); }).reduce(function(a,b) { return Math.max(a,b); });
    for (var event of events) {
        // Reverse each event internally
        event.reverse();
        // Now reverse the order of events
        event.start = begin + (end - event.end());
    }
}

function create_layer_handle(layer) {
    var element = $(`
                    <li style="display: list-item;" class="mjs-nestedSortable-branch mjs-nestedSortable-expanded">
                    <div class="layerhandle-contents">
                    <span class="layerhandle-header">
                    <input type='radio' name='layerhandle-radio'>
                    <span class='layer-title'></span>
                    <button type='button' class='layer-rename'>rename</button>
                    <button type='button' class='layer-delete'>delete</button>
                    </span>
                    <div class='layer-timeline' style="display: flex; justify-content: flex-end"></div>
                    </div>
                    </li>`);
    element.attr('id', layer.handle_id);
    element.find('.layer-title').text(layer.title);
    element.find('input[name="layerhandle-radio"]').click(update_layers);
    element.find('.layer-rename').click(function() {
        begin_rename_layer(layer);
    })
    element.find('.layer-delete').click(function() {
        delete_layer(layer);
    })
    element.find('.layer-timeline').append(layer.timeline.canvas);
    if (layer.background_image !== null) {
        element.find('.layerhandle-contents').addClass('image-layer');
    }
    layer.timeline.needs_redraw = true;
    return element;
}

function get_layer_handles_in_order_helper(objs, arr) {
    for (var obj of objs) {
        arr.push("layerhandle_" + obj.id);
        if (obj.children !== undefined) {
            get_layer_handles_in_order_helper(obj.children, arr);
        }
    }
}

function get_layer_handles_in_order() {
    var hierarchy = $("#layer_selector").nestedSortable('toHierarchy', {startDepthCount: 0});
    var ids_in_order = [];
    get_layer_handles_in_order_helper(hierarchy, ids_in_order);
    return ids_in_order;
}

function set_layer_relationships_helper(parent, layer_dict) {
    var parent_obj = layer_dict["layerhandle_" + parent.id];
    parent_obj.children = [];
    if (parent.children !== undefined) {
        for (var child of parent.children) {
            var child_obj = layer_dict["layerhandle_" + child.id];
            child_obj.parent = parent_obj;
            parent_obj.children.push(child_obj);
            set_layer_relationships_helper(child, layer_dict);
        }
    }
}

function set_layer_relationships() {
    var hierarchy = $("#layer_selector").nestedSortable('toHierarchy', {startDepthCount: 0});
    var layer_dict = {};
    for (var layer of layers) {
        layer_dict[layer.handle_id] = layer;
    }
    for (var obj of hierarchy) {
        layer_dict["layerhandle_" + obj.id].parent = null;
        set_layer_relationships_helper(obj, layer_dict);
    }
}

function update_layers() {
    var layer_handle_ids = get_layer_handles_in_order();
    var in_order = [];

    var claimed_layer_ids = new Set();

    // Re-sort layers based on the order of the layer handles
    for (var id of layer_handle_ids) {
        var index = layers.findIndex(function(e) {
            return e.handle_id === id;
        });
        if (index !== -1) {
            claimed_layer_ids.add(layers[index].id);
            in_order.push(layers[index]);
            layers.splice(index, 1);
        } else {
            // Handle deletes.
            // Note: this selector may be empty if it's a child of an already-deleted layer.
            // But that's okay. The deletion will gracefully fail and do nothing, which is
            // exactly what we want.
            $("#" + id).closest("li").remove();
        }
    }

    // Remove canvases for layers that are now deleted.
    var unclaimed_layers = $("#layer_set canvas").filter(function() {
        return this.id.startsWith("layer-") && !claimed_layer_ids.has(this.id);
    });
    unclaimed_layers.remove();

    // Add new layers to the handle list and layer set
    for (var i = 0; i < layers.length; i++) {
        // Create and append the handle.
        var handle = create_layer_handle(layers[i]);

        if (layers[i].parent === null) {
            // If the layer has no parent, just put the handle at the end of the list.
            handle.appendTo($("#layer_selector"));
        } else {
            // Otherwise, insert it into the list underneath its parent. We may need to create this list.
            var parent_handle = layers[i].parent.handle_id;
            var lst = $("#" + parent_handle + " ol");
            if (lst.length === 0) {
                lst = $("<ol></ol>").appendTo($("#" + parent_handle));
            }
            handle.appendTo(lst);
        }

        // Append the canvas.
        $("#layer_set").append(layers[i].canvas);
    }

    layers = in_order.concat(layers);

    // Set layer parent and child pointers
    set_layer_relationships();

    // Handle renames
    for (var layer of layers) {
        $("#" + layer.handle_id).find(".layer-title").first().text(layer.title);
    }

    // Reorder the actual canvas elements
    for (var i = 0; i < layers.length; i++) {
        $(layers[i].canvas).css("z-index", layers.length-i);
    }
    $("#viewport-overlay").css("z-index", layers.length+1);
    $("#tool-overlay").css("z-index", layers.length+2);

    // Resize the timeline (since there is more/less space available if the maximum
    // nesting level descreased/increased).
    resize_timelines();

    // Now, the rest is about selecting layers. If there are no layers, just leave.
    if (layers.length === 0) {
        current_layer = null;
        return;
    }

    // If the current layer was deleted, clear selection
    if (layers.indexOf(current_layer) === -1) {
        current_layer = null;
    }

    var selected = $("#layer_selector input[name='layerhandle-radio']:checked");

    // Now there are three cases:
    if (selected.length > 0) {
        // Change the selection
        var handle_id = selected.closest("li").attr("id");
        for (var layer of layers) {
            if (layer.handle_id === handle_id) {
                current_layer = layer;
                break;
            }
        }
    } else {
        if (current_layer === null) {
            // If no element is selected, select the first one
            current_layer = layers[0];
            $("#" + current_layer.handle_id)
                .find("input[name='layerhandle-radio']").first()
                .prop("checked", true);
        } else { // current_layer !== null
            // Checkbox was unset by a move. Reset it.
            $("#" + current_layer.handle_id)
                .find("input[name='layerhandle-radio']").first()
                .prop("checked", true);
        }
    }
}

function layer_name_taken(name) {
    for (var layer of layers) {
        if (layer.title === name) {
            return true;
        }
    }
    return false;
}

function new_layer(event, image_data_url = null) {
    while (layer_name_taken("Layer " + next_layer_key)) {
        next_layer_key++;
    }
    layers.push(new Layer("Layer " + next_layer_key, next_layer_key, image_data_url));
    next_layer_key++;
    update_layers();
}

function get_layer_descendants_helper(layer, descendants) {
    descendants.push(layer);
    for (var child of layer.children) {
        get_layer_descendants_helper(child, descendants);
    }
}

function get_layer_descendants(layer) {
    var descendants = [];
    get_layer_descendants_helper(layer, descendants);
    return descendants;
}

function get_layer_ancestors_helper(layer, ancestors) {
    ancestors.push(layer);
    if (layer.parent !== null) {
        get_layer_ancestors_helper(layer.parent, ancestors);
    }
}

function get_layer_ancestors(layer) {
    var ancestors = [];
    get_layer_ancestors_helper(layer, ancestors);
    return ancestors;
}

function shallow_array_equals(a1, a2) {
    return a1.length==a2.length && a1.every(function(v,i) { return v === a2[i]});
}

function matrix_equals(m1, m2) {
    if (m1 === null && m2 === null) return true;
    if (m1 === null || m2 === null) return false;
    return (m1.a == m2.a) &&
        (m1.b == m2.b) &&
        (m1.c == m2.c) &&
        (m1.d == m2.d) &&
        (m1.e == m2.e) &&
        (m1.f == m2.f);
}

function matrix_clone(m) {
    var clone = getIdentityMatrix();
    clone.a = m.a;
    clone.b = m.b;
    clone.c = m.c;
    clone.d = m.d;
    clone.e = m.e;
    clone.f = m.f;
    return clone;
}

function delete_layer(layer) {
    var targets = new Set(get_layer_descendants(layer));
    for (var i = 0; i < layers.length;) {
        if (targets.has(layers[i])) {
            layers.splice(i, 1);
        } else {
            ++i;
        }
    }
    update_layers();
}

function body_mouseup(event) {
    if (global_mouse_action) {
        event.stopPropagation();
        set_current_project_time();
        global_mouse_action.mouseup(event);
        global_mouse_action = null;
    }
}

function body_mousemove(event) {
    if (global_mouse_action) {
        event.stopPropagation();
        set_current_project_time();
        global_mouse_action.mousemove(event);
    }
}

function canvas_mousemove(event) {
    if (global_mouse_action) {
        return;
    }
    if (current_action && current_action.mousemove_nodrag) {
        event.stopPropagation();
        set_current_project_time();
        current_action.mousemove_nodrag(event);
    }
}

function canvas_wheel(event) {
    if (current_action && current_action.wheel) {
        event.stopPropagation();
        event.preventDefault();
        set_current_project_time();
        current_action.wheel(event);
    }
}

function canvas_mousedown(event) {
    if (global_mouse_action) {
        return;
    }
    if (current_action && current_layer) {
        event.stopPropagation();
        set_current_project_time();
        current_action.mousedown(event);
        global_mouse_action = {
            mousemove: function(event) { current_action.mousemove(event); },
            mouseup: function(event) { current_action.mouseup(event); },
        };
    }
}

function play() {
    if (!playing) {
        var now = new Date();
        last_real_time = now.getTime();
        playing = true;
    }
}

function stop() {
    if (playing) {
        set_current_project_time();
        last_project_time = current_project_time;
        playing = false;
    }
}

function go() {
    if (!playing) {
        var time = 1000*parseFloat($("#time").val());
        if (!isNaN(time)) {
            last_project_time = time;
        }
        $("#time").val(last_project_time / 1000);
    }
}

function tool_change() {
    if (current_action) current_action.finish();
    for (var i = 0; i < actions.length; i++) {
        if (actions[i].key == this.value) {
            current_action = actions[i].tool;
            break;
        }
    }
    if (current_action) current_action.start();
}

function ExportManager(filename, fps, width, height, start_time, end_time, success, error, progress) {
    this.filename = filename;
    this.fps = fps;
    this.width = width;
    this.height = height;
    this.start_time = start_time;
    this.end_time = end_time;
    this.success = success;
    this.error = error;
    this.progress = progress;

    // Make a canvas for collapsing layers.
    var jCanvas = $('<canvas></canvas>');
    jCanvas.attr("width", width);
    jCanvas.attr("height", height);
    this.canvas = jCanvas.get(0);
    this.ctx = this.canvas.getContext("2d");
}

ExportManager.prototype.make_progress_object = function() {
    var last_exported_frame = parseInt(this.last_request_sent);
    if (isNaN(last_exported_frame)) {
        last_exported_frame = 0;
    }
    var last_exported_time = this.start_time + last_exported_frame / this.fps;
    return {
        last_request_sent: this.last_request_sent,
        progress_percent: 100 * (last_exported_time - this.start_time) / (this.end_time - this.start_time),
        progress_time: last_exported_time - this.start_time,
        total_time: this.end_time - this.start_time,
        progress_frames: last_exported_frame,
        total_frames: Math.floor((this.end_time - this.start_time) * this.fps),
    };
}

ExportManager.prototype.post = function(url, data) {
    $.ajax({
        type: "POST",
        url: url,
        data: data,
        success: this.handle_server_response.bind(this),
        error: this.handle_server_response.bind(this),
    });
}

ExportManager.prototype.do_export = function() {
    this.client_status = "ok";
    this.server_status = "working";
    this.last_request_sent = "start_export";

    tick_callbacks["export"] = this.maybe_send_next_server_request.bind(this);

    this.post("../start_export", {
        filename: this.filename,
        fps: this.fps,
        frame_width: this.width,
        frame_height: this.height,
    });
}

ExportManager.prototype.cancel_export = function() {
    console.log("Setting export client state to canceled");
    this.client_status = "canceled";
}

ExportManager.prototype.cleanup = function() {
    delete tick_callbacks["export"];
}

ExportManager.prototype.handle_server_response = function(data, status) {
    if (status !== "success") {
        console.log("Export manager finished in error state.");
        this.server_status = "error";
        this.error(data, status);
        this.cleanup();
        return;
    }

    if (this.last_request_sent === "cancel_export") {
        console.log("Export manager finished in cancel state.");
        this.server_status = "finished";
        this.cleanup();
        return;
    }

    if (this.last_request_sent === "finish_export") {
        console.log("Export manager finished in success state.");
        this.server_status = "finished";
        this.success(data, status);
        this.cleanup();
        return;
    }

    this.server_status = "ready";
    this.progress(this.make_progress_object());
    this.maybe_send_next_server_request();
}

ExportManager.prototype.maybe_send_next_server_request = function() {
    if (this.server_status !== "ready") {
        return;
    }

    // Compute the next request.
    var next_request = null;
    var draw_time = null;
    if (this.client_status === "canceled") {
        next_request = "cancel_export";
    } else if (this.last_request_sent === "start_export") {
        next_request = 0;
    } else {
        var i = parseInt(this.last_request_sent);
        if (!isNaN(i)) {
            next_request = i + 1;
        }
    }
    if (typeof next_request === "number") {
        draw_time = 1000.0 * (this.start_time + next_request / this.fps);
        if (draw_time > 1000.0 * this.end_time) {
            next_request = "finish_export";
            draw_time = null;
        }
    }
    if (next_request === null) {
        return;
    }

    // Send cancel if applicable.
    if (next_request === "cancel_export") {
        this.post("../cancel_export", {});
        this.last_request_sent = next_request;
        this.server_status = "working";
    }

    // Send finish if applicable.
    if (next_request === "finish_export") {
        this.post("../finish_export", {});
        this.last_request_sent = next_request;
        this.server_status = "working";
    }

    // Handle write_frame request.
    if (typeof next_request === "number" && draw_time !== null) {
        if (last_tick === draw_time) {
            // If we are already at the right project time, do the export.
            var frame_data = this.get_current_frame_data();
            this.post("../write_frame", {data_url: frame_data});
            this.last_request_sent = next_request;
            this.server_status = "working";
        } else {
            // Otherwise, we need to redraw at the right time.
            last_project_time = draw_time;
            set_current_project_time();
            $("#time").val(current_project_time / 1000);
        }
    }
}

ExportManager.prototype.get_current_frame_data = function() {
    // Pull out the set of relevant layers.
    var layers_to_collapse = []
    $("#layer_set canvas").each(function(index, element) {
        if (element.id === "viewport-overlay" || element.id === "tool-overlay") return;
        if ($(element).css("visibility") === "hidden") return;
        var z_index = $(element).css("z-index");
        layers_to_collapse.push({
            z_index: z_index,
            element: element,
        });
    });

    // Sort by z-index.
    layers_to_collapse.sort(function(a, b) {
        return a.z_index - b.z_index;
    });

    // Collapse down to a single layer.
    this.ctx.clearRect(0, 0, this.width, this.height);
    for (var layer of layers_to_collapse) {
        this.ctx.drawImage(layer.element, 0, 0, this.width, this.height);
    }
    return this.canvas.toDataURL();
}

function main_keydown_handler(e) {
    if (e.key == "Delete") {
        remove_events(selection);
        selection = [];
    } else if (e.key == "s") {
        add_visibility_event(current_layer, true);
    } else if (e.key == "h") {
        add_visibility_event(current_layer, false);
    } else if (!isNaN(parseInt(e.key))) {
        var num = (parseInt(e.key) + 9) % 10;
        add_visibility_event(current_layer, num);
    } else if (e.key == "b" || e.key == "B") {
        var stretch = (e.key == "B");
        remove_events(selection);
        for (var event of selection) {
            set_event_start(event, current_project_time, stretch);
        }
        add_events(selection);
    } else if (e.key == "e" || e.key == "E") {
        var stretch = (e.key == "E");
        var can_do = true;
        // Check that this action wouldn't make any of the events start before 0
        for (var event of selection) {
            if (current_project_time - (event.end() - event.begin()) < 0 &&
                !stretch) {
                can_do = false;
                break;
            }
        }
        if (can_do) {
            remove_events(selection);
            for (var event of selection) {
                set_event_end(event, current_project_time, stretch);
            }
            add_events(selection);
        }
    } else if (e.key == "d") {
        if (selection.length >= 3) {
            remove_events(selection);
            distribute_events(selection);
            add_events(selection);
        }
    } else if (e.key == "D") {
        if (selection.length >= 2) {
            remove_events(selection);
            distribute_spaces(selection);
            add_events(selection);
        }
    } else if (e.key == "c") {
        remove_events(selection);
        var old_selection = selection;
        selection = [];
        for (var event of old_selection) {
            var new_events = cut_event(event, current_project_time);
            Array.prototype.push.apply(selection, new_events);
        }
        add_events(selection);
    } else if (e.key == "r") {
        remove_events(selection);
        for (var event of selection) {
            event.reverse();
        }
        add_events(selection);
    } else if (e.key == "R") {
        remove_events(selection);
        reverse_events(selection);
        add_events(selection);
    }
}

function get_layer_by_id(id) {
    for (var layer of layers) {
        if (layer.id === id) {
            return layer;
        }
    }
    throw "Layer not found: " + id;
}

$(document).ready(function () {
    last_project_time = 0;

    var now = new Date();
    last_real_time = now.getTime();

    addMatrixTrackingToContext(document.getElementById("tool-overlay").getContext("2d"));

    $("#tool-overlay").on("mousedown", canvas_mousedown);
    $("#tool-overlay").on("mousemove", canvas_mousemove);
    $("#tool-overlay").on("wheel", canvas_wheel);
    $("body").on("mousemove", body_mousemove);
    $("body").on("mouseup", body_mouseup);
    $("body").on("mouseleave", body_mouseup);

    $("#play").on("click", play);
    $("#stop").on("click", stop);
    $("#go").on("click", go);
    $("#export_dialog_button").on("click", begin_export_dialog);
    $("#save_project").on("click", begin_save);
    $("#save_project_as").on("click", begin_save_as_dialog);
    $("#open_project").on("click", begin_open_dialog);
    $("#new_layer").on("click", new_layer);
    $("#new_image").on("click", begin_add_image);
    $("#reset_viewport").on("click", function() { viewport_matrix = getIdentityMatrix(); });

    for (var i = 0; i < actions.length; i++) {
        var text = (actions[i].creation !== undefined) ?
            actions[i].creation() :
            document.createTextNode(actions[i].title);
        $("<input type='radio' name='tool'>")
            .attr("value", actions[i].key)
            .appendTo($("#tool_set"));
        $("#tool_set").append(text);
    }
    $("#tool_set input:first-child").attr("checked", "checked");
    $("input[type=radio][name=tool]").change(tool_change);
    $("input[type=radio][name=tool]:checked").change();

    // Keystrokes
    $("body").on("keydown", function(e) {
        if (current_action && current_action.wants_keyboard_input) {
            set_current_project_time();
            current_action.keydown(e);
        } else {
            main_keydown_handler(e);
        }
    });
    // Don't capture keystrokes when in text fields.
    $("input:text").on("keydown", function(e) {
        e.stopPropagation();
    });

    $("#stroke_width").slider({
        range: "min",
        min: 1,
        max: 25,
        value: 1,
    });

    // Create the layers
    layers = [];
    $( "#layer_selector" ).nestedSortable({
        forcePlaceholderSize: true,
        handle: 'div',
        helper: 'clone',
        items: 'li',
        opacity: .6,
        placeholder: 'placeholder',
        revert: 250,
        tabSize: 25,
        tolerance: 'pointer',
        toleranceElement: '> div',
        stop: function() {
            update_layers();
        },
    });
    $( "#layer_selector" ).disableSelection();
    update_layers();

    // Paint the background
    var ctx = document.getElementById("background").getContext("2d");
    ctx.fillStyle = "#FAF7F8";
    ctx.beginPath();
    ctx.rect(0, 0, 1280, 720);
    ctx.closePath();
    ctx.fill();

    // Set up the layer rename dialog
    make_rename_dialog();

    // Set up the add image dialog
    make_image_dialog();

    // Set up the export video dialog
    make_export_dialogs();

    // Set up the save/open dialogs
    make_save_dialogs();
    make_open_dialogs();

    // Set up a resize handler to resize the timelines
    // TODO: this might act badly if we resize the window while we are
    // moving layers around.
    $( window ).resize(resize_timelines);

    window.requestAnimationFrame(tick);
});
