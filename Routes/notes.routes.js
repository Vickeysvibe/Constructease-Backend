import {
  createNote,
  getAllNotes,
  getNoteById,
  updateNote,
  deleteNote,
} from "../Controllers/notes.controller.js";
import express from "express";
const router = express.Router();
router.post("/createnotes", createNote);
router.get("/getnotes", getAllNotes);
router.get("/getnotesid/:noteId", getNoteById);
router.put("/updatenotes/:noteId", updateNote);
router.delete("/deletenotes/:noteId", deleteNote);

export default router;
