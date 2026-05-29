import Notes from "../Models/Notes.model.js";

import mongoose from "mongoose";

export const createNote = async (req, res) => {
  try {
    const { id, title, sheetsLink, context, siteId } = req.body;
    console.log(req.body)

    if (!title || !siteId) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    let existingNote = null;
    if (id && mongoose.Types.ObjectId.isValid(id)) {
      existingNote = await Notes.findById(id);
    }

    if (existingNote) {
      existingNote.title = title;
      existingNote.sheetsLink = sheetsLink || null;
      existingNote.context = sheetsLink ? null : context || null;
      await existingNote.save();
      return res
        .status(200)
        .json({ message: "Note updated successfully", note: existingNote });
    }

    // Create a new note if no valid existing ID is provided
    const noteData = {
      title,
      sheetsLink: sheetsLink || null,
      context: sheetsLink ? null : context || null,
      siteId,
    };

    const newNote = new Notes(noteData);
    await newNote.save();

    res.status(201).json({ message: "Note created successfully", note: newNote });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: error.message });
  }
};


export const updateNote = async (req, res) => {
  try {
    const { noteId } = req.params;
    const { title, sheetsLink, context } = req.body;

    const updatedData = {
      ...(title && { title }),
      sheetsLink: sheetsLink || null,
      context: sheetsLink ? null : context || null,
    };

    const updatedNote = await Notes.findByIdAndUpdate(noteId, updatedData, {
      new: true,
    });

    if (!updatedNote) {
      return res.status(404).json({ message: "Note not found" });
    }

    res
      .status(200)
      .json({ message: "Note updated successfully", note: updatedNote });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getAllNotes = async (req, res) => {
  try {
    const { siteId } = req.query;

    if (!siteId) {
      return res.status(400).json({ message: "Site ID is required" });
    }

    const notes = await Notes.find({ siteId });
    res.status(200).json(notes);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getNoteById = async (req, res) => {
  try {
    const { noteId } = req.params;

    const note = await Notes.findById(noteId);

    if (!note) {
      return res.status(404).json({ message: "Note not found" });
    }

    res.status(200).json(note);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteNote = async (req, res) => {
  try {
    const { noteId } = req.params;

    const deletedNote = await Notes.findByIdAndDelete(noteId);

    if (!deletedNote) {
      return res.status(404).json({ message: "Note not found" });
    }

    res.status(200).json({ message: "Note deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
